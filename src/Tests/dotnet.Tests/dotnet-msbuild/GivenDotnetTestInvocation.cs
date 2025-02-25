﻿// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

using FluentAssertions;
using Microsoft.DotNet.Tools.Test;
using Microsoft.NET.TestFramework;
using Xunit;

namespace Microsoft.DotNet.Cli.MSBuild.Tests
{
    [Collection(TestConstants.UsesStaticTelemetryState)]
    public class GivenDotnetTestInvocation : IClassFixture<NullCurrentSessionIdFixture>
    {
        private const string ExpectedPrefix =
            "-maxcpucount -verbosity:m -restore -target:VSTest -nodereuse:false -nologo";
        private static readonly string WorkingDirectory =
            TestPathUtilities.FormatAbsolutePath(nameof(GivenDotnetTestInvocation));

        [Theory]
        [InlineData(new string[] { "--disable-build-servers" }, "-p:UseRazorBuildServer=false -p:UseSharedCompilation=false /nodeReuse:false -property:VSTestArtifactsProcessingMode=collect -property:VSTestSessionCorrelationId=<testSessionCorrelationId>")]
        public void MsbuildInvocationIsCorrect(string[] args, string expectedAdditionalArgs)
        {
            CommandDirectoryContext.PerformActionWithBasePath(WorkingDirectory, () =>
            {
                Telemetry.Telemetry.DisableForTests();

                expectedAdditionalArgs =
                    (string.IsNullOrEmpty(expectedAdditionalArgs) ? "" : $" {expectedAdditionalArgs}")
                    .Replace("<cwd>", WorkingDirectory);

                var testSessionCorrelationId = "<testSessionCorrelationId>";
                var msbuildPath = "<msbuildpath>";
               
                TestCommand.FromArgs(args, testSessionCorrelationId, msbuildPath)
                    .GetArgumentsToMSBuild()
                    .Should().Be($"{ExpectedPrefix}{expectedAdditionalArgs}");
            });
        }
    }
}
