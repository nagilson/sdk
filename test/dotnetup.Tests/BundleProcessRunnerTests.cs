// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.Versioning;
using FluentAssertions;
using Microsoft.DotNet.Tools.Bootstrapper.WindowsInstaller;

namespace Microsoft.DotNet.Tools.Dotnetup.Tests;

/// <summary>
/// Tests for <see cref="BundleProcessRunner"/> timeout handling. Every test uses a fake process; no installer is run.
/// </summary>
[TestClass]
public class BundleProcessRunnerTests
{
    private static readonly TimeSpan s_timeout = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan s_gracePeriod = TimeSpan.FromSeconds(45);

    [TestMethod]
    public void Run_InstallerExitsWithinTimeout_ReturnsExitCodeWithoutStopping()
    {
        var process = new FakeBundleProcess { ExitsBeforeTimeout = true, ExitCode = 3010 };
        var notices = new StringWriter();

        BundleRunResult result = Run(process, notices);

        result.Should().Be(new BundleRunResult(BundleRunOutcome.Exited, 3010));
        process.Waits.Should().Equal(s_timeout);
        process.CancelRequests.Should().Be(0);
        process.KillRequests.Should().BeEmpty();
        process.Disposed.Should().BeTrue();
        notices.ToString().Should().BeEmpty();
    }

    [TestMethod]
    public void Run_TimeoutThenCancelledWithinGracePeriod_ReturnsStoppedWithExitCode()
    {
        var process = new FakeBundleProcess { ExitsAfterCancel = true, ExitCode = 1602 };
        var notices = new StringWriter();

        BundleRunResult result = Run(process, notices);

        result.Should().Be(new BundleRunResult(BundleRunOutcome.StoppedAfterTimeout, 1602));
        process.Waits.Should().Equal(s_timeout, s_gracePeriod);
        process.CancelRequests.Should().Be(1);
        process.KillRequests.Should().BeEmpty();
        process.Disposed.Should().BeTrue();
        notices.ToString().Should().Contain("10 minutes").And.Contain("45 seconds");
    }

    [TestMethod]
    [DataRow(true)]
    [DataRow(false)]
    public void Run_NotStoppedWithinGracePeriod_KillsEntireProcessTree(bool cancelDelivered)
    {
        var process = new FakeBundleProcess { CancelDelivered = cancelDelivered, ExitsAfterKill = true };

        BundleRunResult result = Run(process);

        result.Should().Be(new BundleRunResult(BundleRunOutcome.TerminatedAfterTimeout, null));
        process.CancelRequests.Should().Be(1);
        process.KillRequests.Should().Equal(true);
        process.Waits.Should().Equal(s_timeout, s_gracePeriod, BundleProcessRunner.TerminationWait);
        process.Disposed.Should().BeTrue();
    }

    [TestMethod]
    public void Run_CancelRequestThrows_IsToleratedAndStillKills()
    {
        var process = new FakeBundleProcess { CancelException = new Win32Exception(5), ExitsAfterKill = true };

        BundleRunResult result = Run(process);

        result.Outcome.Should().Be(BundleRunOutcome.TerminatedAfterTimeout);
        process.KillRequests.Should().Equal(true);
    }

    [TestMethod]
    public void Run_ProcessExitedBeforeKill_ReportsTerminated()
    {
        var process = new FakeBundleProcess { KillException = new InvalidOperationException("exited"), ExitsAfterKill = true };

        BundleRunResult result = Run(process);

        result.Outcome.Should().Be(BundleRunOutcome.TerminatedAfterTimeout);
    }

    [TestMethod]
    [DataRow("aggregate")]
    [DataRow("win32")]
    public void Run_PartOfTreeCannotBeKilled_ReportsTerminationFailed(string failure)
    {
        // An unelevated dotnetup cannot kill the elevated Burn engine.
        Exception killException = failure == "aggregate"
            ? new AggregateException(new Win32Exception(5))
            : new Win32Exception(5);
        var process = new FakeBundleProcess { KillException = killException, ExitsAfterKill = true };

        BundleRunResult result = Run(process);

        result.Should().Be(new BundleRunResult(BundleRunOutcome.TerminationFailed, null));
        process.Disposed.Should().BeTrue();
    }

    [TestMethod]
    public void Run_KilledProcessDoesNotExit_ReportsTerminationFailed()
    {
        var process = new FakeBundleProcess { ExitsAfterKill = false };

        BundleRunResult result = Run(process);

        result.Outcome.Should().Be(BundleRunOutcome.TerminationFailed);
    }

    [TestMethod]
    public void Run_StartsBundleDirectlyWithArguments()
    {
        ProcessStartInfo? startInfo = null;
        var runner = new BundleProcessRunner(
            info =>
            {
                startInfo = info;
                return new FakeBundleProcess { ExitsBeforeTimeout = true };
            },
            s_gracePeriod,
            TextWriter.Null);

        runner.Run("installer.exe", ["/install", "/quiet"], s_timeout, () => { });

        startInfo!.FileName.Should().Be("installer.exe");
        startInfo.UseShellExecute.Should().BeFalse();
        startInfo.ArgumentList.Should().Equal("/install", "/quiet");
    }

    [TestMethod]
    [DataRow(0)]
    [DataRow(-1)]
    public void Run_NonPositiveTimeout_Throws(int minutes)
    {
        var runner = new BundleProcessRunner(_ => new FakeBundleProcess(), s_gracePeriod, TextWriter.Null);

        Assert.ThrowsExactly<ArgumentOutOfRangeException>(
            () => runner.Run("installer.exe", [], TimeSpan.FromMinutes(minutes), () => { }));
    }

    [TestMethod]
    public void GracePeriod_AllowsTimeForRollback()
    {
        BundleProcessRunner.GracePeriod.Should().BeGreaterThanOrEqualTo(TimeSpan.FromSeconds(60));
    }

    [TestMethod]
    [OSCondition(OperatingSystems.Windows)]
    [SupportedOSPlatform("windows")]
    public void BurnCancellation_ProcessTreeIncludesRoot()
    {
        uint currentProcessId = (uint)Environment.ProcessId;

        BurnCancellation.GetProcessTree(currentProcessId).Should().Contain(currentProcessId);
    }

    [TestMethod]
    [OSCondition(OperatingSystems.Windows)]
    [SupportedOSPlatform("windows")]
    public void BurnCancellation_ProcessWithoutBootstrapperWindow_ReportsNotDelivered()
    {
        BurnCancellation.FindWindows(new HashSet<uint> { (uint)Environment.ProcessId }, BurnCancellation.BootstrapperApplicationWindowClass)
            .Should().BeEmpty();
        BurnCancellation.RequestCancel(Environment.ProcessId).Should().BeFalse();
    }

    private static BundleRunResult Run(FakeBundleProcess process, TextWriter? notices = null) =>
        new BundleProcessRunner(_ => process, s_gracePeriod, notices ?? TextWriter.Null)
            .Run("installer.exe", ["/install"], s_timeout, () => { });

    /// <summary>
    /// Simulates an installer process. Each wait reports whether the process exits in the current phase:
    /// before the timeout, after the cancel request, or after the kill.
    /// </summary>
    private sealed class FakeBundleProcess : IBundleProcess
    {
        private bool _cancelRequested;
        private bool _killed;

        public bool ExitsBeforeTimeout { get; init; }

        public bool ExitsAfterCancel { get; init; }

        public bool ExitsAfterKill { get; init; }

        public bool CancelDelivered { get; init; } = true;

        public Exception? CancelException { get; init; }

        public Exception? KillException { get; init; }

        public int ExitCode { get; init; }

        public List<TimeSpan> Waits { get; } = [];

        public int CancelRequests { get; private set; }

        public List<bool> KillRequests { get; } = [];

        public bool Disposed { get; private set; }

        public bool WaitForExit(TimeSpan timeout)
        {
            Waits.Add(timeout);
            return _killed ? ExitsAfterKill
                : _cancelRequested ? ExitsAfterCancel
                : ExitsBeforeTimeout;
        }

        public bool RequestCancel()
        {
            CancelRequests++;
            _cancelRequested = true;
            return CancelException is null ? CancelDelivered : throw CancelException;
        }

        public void Kill(bool entireProcessTree)
        {
            KillRequests.Add(entireProcessTree);
            _killed = true;
            if (KillException is not null)
            {
                throw KillException;
            }
        }

        public void Dispose() => Disposed = true;
    }
}
