// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.Dotnet.Installation;
using Microsoft.Dotnet.Installation.Internal;
using Microsoft.DotNet.Tools.Bootstrapper;

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
        using var process = new Process();
        process.StartInfo.FileName = muxerPath;
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.WorkingDirectory = Environment.CurrentDirectory;
        process.StartInfo.Environment["DOTNET_ROOT"] = installRoot;
        if (OperatingSystem.IsWindows())
        {
            process.StartInfo.Environment["DOTNET_ROOT(x86)"] = installRoot;
        }

        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException($"Failed to start '{muxerPath}'.");
            }
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            throw new InvalidOperationException($"Failed to start '{muxerPath}': {ex.Message}", ex);
        }

        process.WaitForExit();
        return process.ExitCode;
    }
}
