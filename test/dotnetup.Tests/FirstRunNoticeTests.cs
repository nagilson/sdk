// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.DotNet.Tools.Bootstrapper;
using Microsoft.DotNet.Tools.Bootstrapper.Telemetry;
using Microsoft.DotNet.Tools.Dotnetup.Tests.Utilities;
using Xunit;

namespace Microsoft.DotNet.Tools.Bootstrapper.Tests;

public class FirstRunNoticeSuppressionTests
{
    // --version is handled by Program.Main (skips telemetry entirely),
    // not by ShouldSuppressNotice. The process-level test below verifies
    // the end-to-end behavior.

    [Theory]
    [InlineData("print-env-script")]
    [InlineData("elevatedadminpath")]
    public void ShouldSuppressNotice_InternalCommands_ReturnsTrue(string command)
    {
        var parseResult = Parser.Parse(new[] { command });
        Assert.True(FirstRunNotice.ShouldSuppressNotice(parseResult));
    }

    [Theory]
    [InlineData("list", "--format", "json")]
    public void ShouldSuppressNotice_FormatJson_ReturnsTrue(params string[] args)
    {
        var parseResult = Parser.Parse(args);
        Assert.True(FirstRunNotice.ShouldSuppressNotice(parseResult));
    }

    [Theory]
    [InlineData("list")]
    [InlineData("list", "--format", "text")]
    public void ShouldSuppressNotice_TextFormat_ReturnsFalse(params string[] args)
    {
        var parseResult = Parser.Parse(args);
        Assert.False(FirstRunNotice.ShouldSuppressNotice(parseResult));
    }

    [Fact]
    public void ShouldSuppressNotice_EmptyArgs_ReturnsFalse()
    {
        var parseResult = Parser.Parse(Array.Empty<string>());
        Assert.False(FirstRunNotice.ShouldSuppressNotice(parseResult));
    }

    [Theory]
    [InlineData("install", "9.0")]
    [InlineData("update")]
    [InlineData("sdk", "install", "9.0")]
    [InlineData("sdk", "update")]
    [InlineData("runtime", "install", "9.0")]
    public void ShouldSuppressNotice_InstallWithoutInteractive_DependsOnEnvironment(params string[] args)
    {
        // When --interactive is not explicitly passed, suppression depends on
        // CommonOptions.IsCIEnvironmentOrRedirected(). In test (redirected) environments
        // this should return true.
        var parseResult = Parser.Parse(args);
        var result = FirstRunNotice.ShouldSuppressNotice(parseResult);
        Assert.Equal(CommonOptions.IsCIEnvironmentOrRedirected(), result);
    }

    [Theory]
    [InlineData("install", "--interactive", "9.0")]
    [InlineData("sdk", "install", "--interactive", "9.0")]
    [InlineData("runtime", "install", "--interactive")]
    [InlineData("update", "--interactive")]
    [InlineData("sdk", "update", "--interactive")]
    public void ShouldSuppressNotice_InstallWithInteractive_ReturnsFalse(params string[] args)
    {
        // When --interactive is explicitly passed, the notice should NOT be suppressed
        var parseResult = Parser.Parse(args);
        Assert.False(FirstRunNotice.ShouldSuppressNotice(parseResult));
    }

    [Fact]
    public void DotnetupProcess_Version_SkipsTelemetryAndNotice()
    {
        // --version bypasses telemetry entirely in Program.Main.
        // Verify stdout has only the version and stderr is clean.
        var (exitCode, stdout, stderr) = DotnetupTestUtilities.RunDotnetupProcessWithStreams(
            new[] { "--version" },
            captureOutput: true,
            workingDirectory: AppContext.BaseDirectory);

        exitCode.Should().Be(0);
        stdout.Trim().Should().Be(Parser.Version);
        stderr.Trim().Should().BeEmpty("--version skips telemetry and should not produce stderr output");
    }
}
