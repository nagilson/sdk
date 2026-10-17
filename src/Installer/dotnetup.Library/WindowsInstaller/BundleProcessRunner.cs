// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;

namespace Microsoft.DotNet.Tools.Bootstrapper.WindowsInstaller;

/// <summary>How a run of a Windows installer bundle ended.</summary>
internal enum BundleRunOutcome
{
    /// <summary>The installer exited on its own within the installer timeout.</summary>
    Exited,

    /// <summary>The timeout elapsed and the installer exited within the grace period after it was asked to cancel.</summary>
    StoppedAfterTimeout,

    /// <summary>The timeout and the grace period elapsed, so the installer's process tree was killed.</summary>
    TerminatedAfterTimeout,

    /// <summary>The timeout and the grace period elapsed and part of the installer's process tree could not be killed.</summary>
    TerminationFailed,
}

/// <summary>The result of running a Windows installer bundle.</summary>
/// <param name="Outcome">How the run ended.</param>
/// <param name="ExitCode">The installer's exit code, or null when it was killed.</param>
internal readonly record struct BundleRunResult(BundleRunOutcome Outcome, int? ExitCode)
{
    public static BundleRunResult Exited(int exitCode) => new(BundleRunOutcome.Exited, exitCode);
}

/// <summary>Runs a Windows installer bundle and waits for it to exit.</summary>
internal interface IBundleProcessRunner
{
    /// <summary>Runs the bundle until it exits or <paramref name="timeout"/> elapses.</summary>
    /// <param name="bundlePath">The installer bundle to run.</param>
    /// <param name="arguments">Command-line arguments for the bundle.</param>
    /// <param name="timeout">
    /// How long the installer may run. When it elapses, the installer is asked to cancel, given
    /// <see cref="BundleProcessRunner.GracePeriod"/> to roll back, and then killed.
    /// </param>
    /// <param name="onCancelRequested">
    /// Invoked when the user asks to cancel (Ctrl+C) while the installer runs. The installer keeps running;
    /// the callback lets the caller avoid starting further work.
    /// </param>
    /// <exception cref="Win32Exception">The process could not be started.</exception>
    BundleRunResult Run(string bundlePath, IReadOnlyList<string> arguments, TimeSpan timeout, Action onCancelRequested);
}

/// <summary>A started installer process. Abstracted so tests never start a real installer.</summary>
internal interface IBundleProcess : IDisposable
{
    /// <summary>Waits up to <paramref name="timeout"/> for the process to exit; returns true if it exited.</summary>
    bool WaitForExit(TimeSpan timeout);

    /// <summary>The exit code; only valid after <see cref="WaitForExit"/> returns true.</summary>
    int ExitCode { get; }

    /// <summary>Asks the installer to cancel; returns false when the request could not be delivered.</summary>
    bool RequestCancel();

    /// <summary>Immediately stops the process and, when requested, its descendants.</summary>
    void Kill(bool entireProcessTree);
}

/// <summary>
/// Starts the bundle directly (no shell). The bundle's manifest requests <c>asInvoker</c>; the Burn engine
/// raises its own UAC prompt for the per-machine work, so dotnetup itself never elevates. Ctrl+C does not stop
/// the installer: abandoning an installer mid-transaction can leave the machine in a partially installed state,
/// so dotnetup waits for it and reports the cancellation request to the caller instead.
/// </summary>
/// <remarks>
/// An installer that runs past its timeout is asked to cancel (<see cref="RequestGracefulStop"/>), given
/// <see cref="GracePeriod"/> to roll back, and then killed (<see cref="ForceStop"/>). dotnetup therefore stops
/// waiting within the timeout plus the grace period plus <see cref="TerminationWait"/>. Killing is a last resort:
/// the elevated Burn engine, which performs the per-machine work, cannot be killed by an unelevated dotnetup and
/// finishes any in-flight package install on its own.
/// </remarks>
internal sealed class BundleProcessRunner : IBundleProcessRunner
{
    /// <summary>
    /// How long an installer that was asked to cancel may take to roll back before it is killed. Burn acts on a
    /// cancel request only at its next engine callback, and rolling back a large MSI chain (such as the SDK's) takes
    /// time.
    /// </summary>
    internal static TimeSpan GracePeriod { get; } = TimeSpan.FromSeconds(120);

    /// <summary>How long to wait for the OS to report the exit after the installer's process tree was killed.</summary>
    internal static TimeSpan TerminationWait { get; } = TimeSpan.FromSeconds(10);

    private readonly Func<ProcessStartInfo, IBundleProcess> _startProcess;
    private readonly TimeSpan _gracePeriod;
    private readonly TextWriter _notices;

    public BundleProcessRunner()
        : this(SystemBundleProcess.Start, GracePeriod, Console.Error)
    {
    }

    internal BundleProcessRunner(Func<ProcessStartInfo, IBundleProcess> startProcess, TimeSpan gracePeriod, TextWriter notices)
    {
        _startProcess = startProcess;
        _gracePeriod = gracePeriod;
        _notices = notices;
    }

    public BundleRunResult Run(string bundlePath, IReadOnlyList<string> arguments, TimeSpan timeout, Action onCancelRequested)
    {
        ArgumentNullException.ThrowIfNull(onCancelRequested);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(timeout, TimeSpan.Zero);
        var startInfo = new ProcessStartInfo(bundlePath) { UseShellExecute = false };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        void WaitForInstaller(object? sender, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;
            onCancelRequested();
            Console.Error.WriteLine("The .NET installer is still running and cannot be cancelled from dotnetup. Waiting for it to finish; no further installs will be started...");
        }

        Console.CancelKeyPress += WaitForInstaller;
        try
        {
            using IBundleProcess process = _startProcess(startInfo);
            return WaitForInstallerToExit(process, timeout);
        }
        finally
        {
            Console.CancelKeyPress -= WaitForInstaller;
        }
    }

    private BundleRunResult WaitForInstallerToExit(IBundleProcess process, TimeSpan timeout)
    {
        if (process.WaitForExit(timeout))
        {
            return BundleRunResult.Exited(process.ExitCode);
        }

        _notices.WriteLine(string.Format(
            CultureInfo.CurrentCulture,
            Strings.InstallerTimeoutStopping,
            FormatMinutes(timeout),
            FormatSeconds(_gracePeriod)));
        RequestGracefulStop(process);
        if (process.WaitForExit(_gracePeriod))
        {
            return new BundleRunResult(BundleRunOutcome.StoppedAfterTimeout, process.ExitCode);
        }

        return ForceStop(process);
    }

    /// <summary>
    /// Asks the installer to cancel and roll back. For Burn bundles this posts <c>WM_CLOSE</c> to the bootstrapper
    /// application's window (see <see cref="BurnCancellation"/>), which the engine turns into a rollback and exit
    /// code 1602 (<c>ERROR_INSTALL_USEREXIT</c>). Failure to deliver the request is tolerated: <see cref="ForceStop"/>
    /// runs after the grace period either way.
    /// </summary>
    private static void RequestGracefulStop(IBundleProcess process)
    {
        try
        {
            process.RequestCancel();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            // The process exited in the meantime, or its windows could not be enumerated.
        }
    }

    /// <summary>
    /// Kills the installer's process tree. This is a last resort that may not stop the installation: the elevated
    /// Burn engine cannot be killed by an unelevated process, outlives its killed parent, and finishes any
    /// in-flight package install. Killing also leaves the engine's extracted files in the temporary directory.
    /// </summary>
    private static BundleRunResult ForceStop(IBundleProcess process)
    {
        bool killedEntireTree = true;
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // The process exited between the end of the grace period and the kill.
        }
        catch (Exception ex) when (ex is Win32Exception or AggregateException or NotSupportedException)
        {
            // Part of the tree could not be stopped, typically the elevated engine.
            killedEntireTree = false;
        }

        return killedEntireTree && process.WaitForExit(TerminationWait)
            ? new BundleRunResult(BundleRunOutcome.TerminatedAfterTimeout, ExitCode: null)
            : new BundleRunResult(BundleRunOutcome.TerminationFailed, ExitCode: null);
    }

    internal static string FormatMinutes(TimeSpan duration) =>
        duration.TotalMinutes.ToString("0.##", CultureInfo.CurrentCulture);

    internal static string FormatSeconds(TimeSpan duration) =>
        duration.TotalSeconds.ToString("0.##", CultureInfo.CurrentCulture);

    /// <summary>Adapts <see cref="Process"/> to <see cref="IBundleProcess"/>.</summary>
    private sealed class SystemBundleProcess(Process process) : IBundleProcess
    {
        public static SystemBundleProcess Start(ProcessStartInfo startInfo) =>
            new SystemBundleProcess(Process.Start(startInfo)
                ?? throw new InvalidOperationException($"The installer '{startInfo.FileName}' did not start."));

        public int ExitCode => process.ExitCode;

        public bool WaitForExit(TimeSpan timeout) => process.WaitForExit(timeout);

        public bool RequestCancel() =>
            OperatingSystem.IsWindows() && BurnCancellation.RequestCancel(process.Id);

        public void Kill(bool entireProcessTree) => process.Kill(entireProcessTree);

        public void Dispose() => process.Dispose();
    }
}
