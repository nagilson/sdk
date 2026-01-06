// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Microsoft.Deployment.DotNet.Releases;
using Microsoft.Dotnet.Installation;
using Microsoft.Dotnet.Installation.Internal;
using Microsoft.DotNet.Tools.Bootstrapper;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.Dotnet;
using Microsoft.DotNet.Tools.Dotnetup.Tests.Utilities;
using Xunit;

namespace Microsoft.DotNet.Tools.Dotnetup.Tests;

public class DotnetForwardCommandTests
{
    [Fact]
    public void ReturnsErrorWhenNoManagedInstallIsAvailable()
    {
        using var testEnv = DotnetupTestUtilities.CreateTestEnvironment();

        var invoker = new RecordingInvoker();
        var originalInvoker = DotnetForwardCommand.ForwardingInvoker;
        DotnetForwardCommand.ForwardingInvoker = invoker;

        try
        {
            var exitCode = InvokeDotnetCommand("dotnet", testEnv.ManifestPath);

            exitCode.Should().Be(1);
            invoker.InvocationCount.Should().Be(0);
        }
        finally
        {
            DotnetForwardCommand.ForwardingInvoker = originalInvoker;
        }
    }

    [Fact]
    public void ForwardsArgumentsToManagedMuxer()
    {
        using var testEnv = DotnetupTestUtilities.CreateTestEnvironment();

        var installRoot = Path.GetFullPath(testEnv.InstallPath);
        CreateMuxerAt(installRoot);
        AddInstallToManifest(testEnv.ManifestPath, installRoot, "9.0.100");

        var invoker = new RecordingInvoker(exitCodeToReturn: 42);
        var originalInvoker = DotnetForwardCommand.ForwardingInvoker;
        DotnetForwardCommand.ForwardingInvoker = invoker;

        try
        {
            var exitCode = InvokeDotnetCommand("dotnet", testEnv.ManifestPath, "--info", "--", "arg1");

            exitCode.Should().Be(42);
            invoker.InvocationCount.Should().Be(1);
            invoker.LastMuxerPath.Should().Be(Path.Combine(installRoot, DotnetupUtilities.GetDotnetExeName()));
            invoker.LastInstallRoot.Should().Be(installRoot);
            invoker.LastArguments.Should().Equal("--info", "arg1");
        }
        finally
        {
            DotnetForwardCommand.ForwardingInvoker = originalInvoker;
        }
    }

    [Fact]
    public void SupportsDoAlias()
    {
        using var testEnv = DotnetupTestUtilities.CreateTestEnvironment();

        var installRoot = Path.GetFullPath(testEnv.InstallPath);
        CreateMuxerAt(installRoot);
        AddInstallToManifest(testEnv.ManifestPath, installRoot, "9.0.200");

        var invoker = new RecordingInvoker();
        var originalInvoker = DotnetForwardCommand.ForwardingInvoker;
        DotnetForwardCommand.ForwardingInvoker = invoker;

        try
        {
            var exitCode = InvokeDotnetCommand("do", testEnv.ManifestPath, "test");

            exitCode.Should().Be(0);
            invoker.InvocationCount.Should().Be(1);
            invoker.LastArguments.Should().Equal("test");
        }
        finally
        {
            DotnetForwardCommand.ForwardingInvoker = originalInvoker;
        }
    }

    [Fact]
    public void PrefersDotnetRootWhenMultipleInstallsExist()
    {
        using var testEnv = DotnetupTestUtilities.CreateTestEnvironment();

        var firstInstall = Path.GetFullPath(testEnv.InstallPath);
        var secondInstall = Path.Combine(testEnv.TempRoot, "second-install");

        CreateMuxerAt(firstInstall);
        CreateMuxerAt(secondInstall);

        AddInstallToManifest(testEnv.ManifestPath, firstInstall, "9.0.300");
        AddInstallToManifest(testEnv.ManifestPath, secondInstall, "10.0.100");

        var originalDotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        Environment.SetEnvironmentVariable("DOTNET_ROOT", secondInstall);

        var invoker = new RecordingInvoker();
        var originalInvoker = DotnetForwardCommand.ForwardingInvoker;
        DotnetForwardCommand.ForwardingInvoker = invoker;

        try
        {
            var exitCode = InvokeDotnetCommand("dotnet", testEnv.ManifestPath);

            exitCode.Should().Be(0);
            invoker.InvocationCount.Should().Be(1);
            invoker.LastInstallRoot.Should().Be(Path.GetFullPath(secondInstall));
        }
        finally
        {
            Environment.SetEnvironmentVariable("DOTNET_ROOT", originalDotnetRoot);
            DotnetForwardCommand.ForwardingInvoker = originalInvoker;
        }
    }

    [Fact]
    public void ReturnsErrorWhenMultipleInstallsAndNoHint()
    {
        using var testEnv = DotnetupTestUtilities.CreateTestEnvironment();

        var firstInstall = Path.GetFullPath(testEnv.InstallPath);
        var secondInstall = Path.Combine(testEnv.TempRoot, "second-install");

        CreateMuxerAt(firstInstall);
        CreateMuxerAt(secondInstall);

        AddInstallToManifest(testEnv.ManifestPath, firstInstall, "9.0.400");
        AddInstallToManifest(testEnv.ManifestPath, secondInstall, "10.0.200");

        var originalDotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        Environment.SetEnvironmentVariable("DOTNET_ROOT", null);

        var invoker = new RecordingInvoker();
        var originalInvoker = DotnetForwardCommand.ForwardingInvoker;
        DotnetForwardCommand.ForwardingInvoker = invoker;

        try
        {
            var exitCode = InvokeDotnetCommand("dotnet", testEnv.ManifestPath);

            exitCode.Should().Be(1);
            invoker.InvocationCount.Should().Be(0);
        }
        finally
        {
            Environment.SetEnvironmentVariable("DOTNET_ROOT", originalDotnetRoot);
            DotnetForwardCommand.ForwardingInvoker = originalInvoker;
        }
    }

    private static int InvokeDotnetCommand(string commandName, string manifestPath, params string[] forwardedArgs)
    {
        var args = new List<string>
        {
            commandName,
            "--manifest-path",
            Path.GetFullPath(manifestPath)
        };

        if (forwardedArgs.Length > 0)
        {
            args.AddRange(forwardedArgs);
        }

        var parseResult = Microsoft.DotNet.Tools.Bootstrapper.Parser.Parse([.. args]);
        return Microsoft.DotNet.Tools.Bootstrapper.Parser.Invoke(parseResult);
    }

    private static void CreateMuxerAt(string installPath)
    {
        Directory.CreateDirectory(installPath);
        var muxerPath = Path.Combine(installPath, DotnetupUtilities.GetDotnetExeName());
        if (!File.Exists(muxerPath))
        {
            File.WriteAllText(muxerPath, string.Empty);
        }
    }

    private static void AddInstallToManifest(string manifestPath, string installPath, string version)
    {
        using var manifestMutex = new ScopedMutex(Constants.MutexNames.ModifyInstallationStates);
        if (!manifestMutex.HasHandle)
        {
            throw new InvalidOperationException("Failed to acquire manifest mutex during test setup.");
        }

        var manifest = new DotnetupSharedManifest(manifestPath);

        var installRoot = new DotnetInstallRoot(Path.GetFullPath(installPath), InstallerUtilities.GetDefaultInstallArchitecture());
        var releaseVersion = new ReleaseVersion(version);

        var dotnetInstallType = typeof(DotnetInstallRoot).Assembly.GetType("Microsoft.Dotnet.Installation.Internal.DotnetInstall")
            ?? throw new InvalidOperationException("Unable to locate DotnetInstall type.");

        var dotnetInstall = Activator.CreateInstance(dotnetInstallType, installRoot, releaseVersion, InstallComponent.SDK)
            ?? throw new InvalidOperationException("Failed to create DotnetInstall instance.");

        var addMethod = typeof(DotnetupSharedManifest).GetMethod(nameof(DotnetupSharedManifest.AddInstalledVersion), BindingFlags.Instance | BindingFlags.Public)
            ?? throw new InvalidOperationException("Unable to locate AddInstalledVersion method.");

        addMethod.Invoke(manifest, new[] { dotnetInstall });
    }

    private sealed class RecordingInvoker : IDotnetForwardingInvoker
    {
        private readonly int _exitCodeToReturn;

        public RecordingInvoker(int exitCodeToReturn = 0)
        {
            _exitCodeToReturn = exitCodeToReturn;
        }

        public int InvocationCount { get; private set; }
        public string? LastMuxerPath { get; private set; }
        public string? LastInstallRoot { get; private set; }
        public IReadOnlyList<string> LastArguments { get; private set; } = Array.Empty<string>();

        public int Invoke(string muxerPath, string installRoot, IReadOnlyList<string> arguments)
        {
            InvocationCount++;
            LastMuxerPath = muxerPath;
            LastInstallRoot = installRoot;
            LastArguments = arguments.ToArray();
            return _exitCodeToReturn;
        }
    }
}
