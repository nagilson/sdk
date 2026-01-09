// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Microsoft.Dotnet.Installation;
using Microsoft.Dotnet.Installation.Internal;
using Microsoft.DotNet.Tools.Bootstrapper;
using Microsoft.Win32.SafeHandles;

namespace Microsoft.DotNet.Tools.Bootstrapper.Commands.Dotnet;

internal sealed class DotnetForwardCommand : CommandBase
{
    private readonly string? _manifestPath;
    private readonly IDotnetInstallManager _dotnetInstallManager = new DotnetInstallManager();

    private static IDotnetForwardingInvoker _forwardingInvoker = new ProcessForwardingInvoker();

    internal static IDotnetForwardingInvoker ForwardingInvoker
    {
        get => _forwardingInvoker;
        set => _forwardingInvoker = value ?? throw new ArgumentNullException(nameof(value));
    }

    public DotnetForwardCommand(ParseResult parseResult) : base(parseResult)
    {
        var manifestPath = parseResult.GetValue(DotnetCommandParser.ManifestPathOption);
        if (!string.IsNullOrWhiteSpace(manifestPath))
        {
            _manifestPath = Path.GetFullPath(manifestPath);
        }
    }

    public override int Execute()
    {
        try
        {
            if (!TryResolveInstallRoot(out var installRoot, out var error))
            {
                if (!string.IsNullOrEmpty(error))
                {
                    Console.Error.WriteLine(error);
                }

                return 1;
            }

            string muxerPath = Path.Combine(installRoot, DotnetupUtilities.GetDotnetExeName());
            if (!File.Exists(muxerPath))
            {
                Console.Error.WriteLine($"The managed dotnet executable was not found at '{muxerPath}'.");
                return 1;
            }

            IReadOnlyList<string> forwardedArgs = GetForwardedArguments();

            return ForwardingInvoker.Invoke(muxerPath, installRoot, forwardedArgs);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private bool TryResolveInstallRoot(out string installRoot, out string? error)
    {
        installRoot = string.Empty;
        error = null;

        using var manifestLock = new ScopedMutex(Constants.MutexNames.ModifyInstallationStates);
        if (!manifestLock.HasHandle)
        {
            error = "Unable to access the dotnetup manifest because another operation is in progress. Try again once it completes.";
            return false;
        }

        var manifest = new DotnetupSharedManifest(_manifestPath);
        var installs = manifest.GetInstalledVersions().ToList();
        if (installs.Count == 0)
        {
            error = "No dotnet installations are managed by dotnetup. Install one with 'dotnetup sdk install'.";
            return false;
        }

        var candidateRoots = installs
            .Select(i => i.InstallRoot.Path)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => Path.GetFullPath(path!))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (candidateRoots.Count == 0)
        {
            error = "No install root paths were recorded in the dotnetup manifest.";
            return false;
        }

        var selectedRoot = SelectInstallRoot(candidateRoots);
        if (selectedRoot is null)
        {
            if (candidateRoots.Count > 1)
            {
                error = "Multiple managed dotnet install locations were found. Set DOTNET_ROOT to the location you want to use or clean up the manifest.";
            }
            else
            {
                error = "Unable to determine the managed dotnet install location.";
            }

            return false;
        }

        installRoot = selectedRoot;
        return true;
    }

    private string? SelectInstallRoot(IReadOnlyList<string> candidateRoots)
    {
        if (candidateRoots.Count == 1)
        {
            return candidateRoots[0];
        }

        string? dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrWhiteSpace(dotnetRoot))
        {
            var normalized = Path.GetFullPath(dotnetRoot);
            var match = candidateRoots.FirstOrDefault(candidate => DotnetupUtilities.PathsEqual(candidate, normalized));
            if (match is not null)
            {
                return match;
            }
        }

        var configuredInstall = _dotnetInstallManager.GetConfiguredInstallType();
        if (configuredInstall?.Path is string configuredPath)
        {
            var match = candidateRoots.FirstOrDefault(candidate => DotnetupUtilities.PathsEqual(candidate, configuredPath));
            if (match is not null)
            {
                return match;
            }
        }

        return null;
    }

    private IReadOnlyList<string> GetForwardedArguments()
    {
        if (_parseResult.UnmatchedTokens.Count == 0)
        {
            return Array.Empty<string>();
        }

        return _parseResult.UnmatchedTokens.ToArray();
    }
}

internal interface IDotnetForwardingInvoker
{
    int Invoke(string muxerPath, string installRoot, IReadOnlyList<string> arguments);
}

internal sealed class ProcessForwardingInvoker : IDotnetForwardingInvoker
{
    public int Invoke(string muxerPath, string installRoot, IReadOnlyList<string> arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = muxerPath,
            UseShellExecute = false,
            WorkingDirectory = Environment.CurrentDirectory
        };

        startInfo.Environment["DOTNET_ROOT"] = installRoot;
        if (OperatingSystem.IsWindows())
        {
            startInfo.Environment["DOTNET_ROOT(x86)"] = installRoot;
        }

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        Process? process = null;
        try
        {
            // On Windows forward to dotnet.exe using a non-elevated token when possible.
            if (OperatingSystem.IsWindows() && WindowsProcessLauncher.TryStartNonElevated(startInfo, out process))
            {
                process.WaitForExit();
                return process.ExitCode;
            }

            process = Process.Start(startInfo);
            if (process is null)
            {
                throw new InvalidOperationException($"Failed to start '{muxerPath}'.");
            }

            process.WaitForExit();
            return process.ExitCode;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            throw new InvalidOperationException($"Failed to start '{muxerPath}': {ex.Message}", ex);
        }
        finally
        {
            process?.Dispose();
        }
    }
}

[SupportedOSPlatform("windows")]
internal static class WindowsProcessLauncher
{
    public static bool TryStartNonElevated(ProcessStartInfo startInfo, out Process? process)
    {
        process = null;

        try
        {
            if (!TryAcquireShellToken(out var shellToken))
            {
                return false;
            }

            using (shellToken)
            {
                if (!NativeMethods.DuplicateTokenEx(
                        shellToken,
                        NativeMethods.TokenAccess,
                        IntPtr.Zero,
                        NativeMethods.SecurityImpersonationLevel.SecurityImpersonation,
                        NativeMethods.TokenType.TokenImpersonation,
                        out var impersonationToken))
                {
                    return false;
                }

                using (impersonationToken)
                {
                    process = WindowsIdentity.RunImpersonated(
                        impersonationToken,
                        () => Process.Start(startInfo));
                }
            }

            return process is not null;
        }
        catch (Win32Exception)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        catch (PlatformNotSupportedException)
        {
            return false;
        }
    }

    [SupportedOSPlatform("windows")]
    private static bool TryAcquireShellToken(out SafeAccessTokenHandle tokenHandle)
    {
        tokenHandle = new SafeAccessTokenHandle(IntPtr.Zero);

        using var currentProcess = Process.GetCurrentProcess();
        var currentSessionId = currentProcess.SessionId;

        foreach (var shellProcess in Process.GetProcessesByName("explorer"))
        {
            using (shellProcess)
            {
                if (shellProcess.SessionId != currentSessionId)
                {
                    continue;
                }

                if (!NativeMethods.OpenProcessToken(shellProcess.SafeHandle, NativeMethods.TokenAccess, out var openedToken))
                {
                    continue;
                }

                tokenHandle = openedToken;
                return true;
            }
        }

        tokenHandle = new SafeAccessTokenHandle(IntPtr.Zero);
        return false;
    }

    private static class NativeMethods
    {
        internal const uint TokenAssignPrimary = 0x0001;
        internal const uint TokenDuplicate = 0x0002;
        internal const uint TokenQuery = 0x0008;
        internal const uint TokenAdjustDefault = 0x0080;
        internal const uint TokenAdjustSessionId = 0x0100;

        internal const uint TokenAccess = TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustDefault | TokenAdjustSessionId;

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern bool OpenProcessToken(SafeHandle processHandle, uint desiredAccess, out SafeAccessTokenHandle tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern bool DuplicateTokenEx(
            SafeAccessTokenHandle existingToken,
            uint desiredAccess,
            IntPtr tokenAttributes,
            SecurityImpersonationLevel impersonationLevel,
            TokenType tokenType,
            out SafeAccessTokenHandle newToken);

        internal enum SecurityImpersonationLevel
        {
            SecurityAnonymous,
            SecurityIdentification,
            SecurityImpersonation,
            SecurityDelegation
        }

        internal enum TokenType
        {
            TokenPrimary = 1,
            TokenImpersonation
        }
    }
}
