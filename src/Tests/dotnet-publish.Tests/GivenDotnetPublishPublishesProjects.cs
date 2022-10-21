// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Xml.Linq;
using FluentAssertions;
using Microsoft.DotNet.Cli.Utils;
using Microsoft.DotNet.Tools;
using Microsoft.NET.TestFramework;
using Microsoft.NET.TestFramework.Assertions;
using Microsoft.NET.TestFramework.Commands;
using Xunit;
using Xunit.Abstractions;
using LocalizableStrings = Microsoft.DotNet.Tools.Publish.LocalizableStrings;

namespace Microsoft.DotNet.Cli.Publish.Tests
{
    public class GivenDotnetPublishPublishesProjects : SdkTest
    {

        private static string _defaultConfiguration = "Debug";

        public GivenDotnetPublishPublishesProjects(ITestOutputHelper log) : base(log)
        {
        }

        [Fact]
        public void ItPublishesARunnablePortableApp()
        {
            var testAppName = "MSBuildTestApp";
            var testInstance = _testAssetsManager.CopyTestAsset(testAppName)
                            .WithSource();

            var testProjectDirectory = testInstance.Path;

            new RestoreCommand(testInstance)
                .Execute()
                .Should().Pass();

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(testProjectDirectory)
                .Execute("--framework", ToolsetInfo.CurrentTargetFramework)
                .Should().Pass();

            var configuration = Environment.GetEnvironmentVariable("CONFIGURATION") ?? _defaultConfiguration;
            var outputDll = Path.Combine(testProjectDirectory, "bin", configuration, ToolsetInfo.CurrentTargetFramework, "publish", $"{testAppName}.dll");

            new DotnetCommand(Log)
                .Execute(outputDll)
                .Should().Pass()
                         .And.HaveStdOutContaining("Hello World");
        }

        [Fact]
        public void ItImplicitlyRestoresAProjectWhenPublishing()
        {
            var testAppName = "MSBuildTestApp";
            var testInstance = _testAssetsManager.CopyTestAsset(testAppName)
                            .WithSource();

            var testProjectDirectory = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(testProjectDirectory)
                .Execute("--framework", ToolsetInfo.CurrentTargetFramework)
                .Should().Pass();
        }

        [Fact(Skip = "https://github.com/dotnet/sdk/issues/19487")]
        public void ItCanPublishAMultiTFMProjectWithImplicitRestore()
        {
            var testInstance = _testAssetsManager.CopyTestAsset(
                    "NETFrameworkReferenceNETStandard20",
                    testAssetSubdirectory: TestAssetSubdirectories.DesktopTestProjects)
                .WithSource();

            string projectDirectory = Path.Combine(testInstance.Path, "MultiTFMTestApp");

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(projectDirectory)
                .Execute("--framework", ToolsetInfo.CurrentTargetFramework)
                .Should().Pass();
        }

        [Fact]
        public void ItDoesNotImplicitlyRestoreAProjectWhenPublishingWithTheNoRestoreOption()
        {
            var testAppName = "MSBuildTestApp";
            var testInstance = _testAssetsManager.CopyTestAsset(testAppName)
                            .WithSource();

            var testProjectDirectory = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(testProjectDirectory)
                .Execute("--framework", "netcoreapp3.0", "--no-restore")
                .Should().Fail()
                .And.HaveStdOutContaining("project.assets.json");
        }

        [Theory]
        [InlineData("publish", "-property", "Configuration=Debug")]
        [InlineData("publish", "-p", "Configuration=Debug")]
        [InlineData("publish", "--property", "Configuration=Debug")]
        public void ItParsesSpacedPropertiesInPublishReleaseEvaluationPhase(string command, string propertyKey, string propertyVal)
        {
            var testInstance = _testAssetsManager.CopyTestAsset("TestAppSimple")
                .WithSource()
                .Restore(Log);

            var rootDir = testInstance.Path;

            new DotnetCommand(Log)
                .WithWorkingDirectory(rootDir)
                .Execute(command, propertyKey, propertyVal)
                .Should().Pass().And.NotHaveStdErr();
        }

        [Theory]
        [InlineData(null)]
        [InlineData("--sc")]
        [InlineData("--self-contained")]
        [InlineData("--sc=true")]
        [InlineData("--self-contained=true")]
        public void ItPublishesSelfContainedWithRid(string args)
        {
            var testAppName = "MSBuildTestApp";
            var rid = EnvironmentInfo.GetCompatibleRid();
            var outputDirectory = PublishApp(testAppName, rid, args);

            var outputProgram = Path.Combine(outputDirectory.FullName, $"{testAppName}{Constants.ExeSuffix}");

            new RunExeCommand(Log, outputProgram)
                .Execute()
                .Should().Pass()
                     .And.HaveStdOutContaining("Hello World");
        }

        [Fact]
        public void ItPublishesSelfContainedWithPublishSelfContainedTrue()
        {
            var testAppName = "MSBuildTestApp";
            var rid = EnvironmentInfo.GetCompatibleRid();
            var outputDirectory = PublishApp(testAppName, rid, "-p:PublishSelfContained=true");

            var outputProgram = Path.Combine(outputDirectory.FullName, $"{testAppName}{Constants.ExeSuffix}");

            outputDirectory.Should().HaveFiles(new[] {
                "System.dll", // File that should only exist if self contained 
            });

            new RunExeCommand(Log, outputProgram)
                .Execute()
                .Should().Pass()
                     .And.HaveStdOutContaining("Hello World");
        }

        [Theory]
        [InlineData("net7.0")]
        public void ItPublishesSelfContainedWithPublishSelfContainedProperty(string targetFramework)
        {
            var rid = EnvironmentInfo.GetCompatibleRid(targetFramework);
            var testAsset = _testAssetsManager
            .CopyTestAsset("HelloWorld", identifier: targetFramework)
            .WithSource()
            .WithTargetFramework(targetFramework)
            .WithProjectChanges(project =>
            {
                var ns = project.Root.Name.Namespace;
                var propertyGroup = project.Root.Elements(ns + "PropertyGroup").First();
                propertyGroup.Add(new XElement(ns + "PublishSelfContained", "true"));
            });

            var publishCommand = new PublishCommand(testAsset);
            var publishResult = publishCommand.Execute($"/p:RuntimeIdentifier={rid}");

            publishResult.Should().Pass();

            var publishDirectory = publishCommand.GetOutputDirectory(
                targetFramework: targetFramework,
                runtimeIdentifier: rid);
            publishDirectory.Should().HaveFiles(new[] {
                "HelloWorld.dll",
                "System.dll"
            });
        }

        [Theory]
        [InlineData("net7.0", true, false, false)]
        [InlineData("net7.0", false, false, false)]
        [InlineData("net7.0", true, true, false)]
        [InlineData("net7.0", true, true, true)]
        public void PublishSelfContainedPropertyDoesOrDoesntOverrideSelfContainProperty(string targetFramework, bool publishSelfContained, bool selfContainedIsGlobal, bool publishSelfContainedIsGlobal)
        {
            var rid = EnvironmentInfo.GetCompatibleRid(targetFramework);

            var testAsset = _testAssetsManager
            .CopyTestAsset("HelloWorld")
            .WithSource()
            .WithProjectChanges(project =>
            {
                var ns = project.Root.Name.Namespace;
                var propertyGroup = project.Root.Elements(ns + "PropertyGroup").First();
                propertyGroup.Add(new XElement(ns + "SelfContained", (!publishSelfContained).ToString()));
                propertyGroup.Add(new XElement(ns + "PublishSelfContained", publishSelfContained.ToString()));
            });

            var publishCommand = new PublishCommand(testAsset);
            List<string> args = new List<string>
            {
                $"/p:RuntimeIdentifier={rid}",
                $"/p:_IsPublishing=true", // Normally this would be set by the CLI (OR VS Soon TM), but this calls directly into t:/Publish.
                selfContainedIsGlobal ? $"/p:SelfContained={!publishSelfContained}" : "",
                publishSelfContainedIsGlobal ? $"/p:PublishSelfContained={publishSelfContained}" : ""
            };

            publishCommand
                .Execute(args.ToArray())
                .Should()
                .Pass();

            var publishedDirectory = publishCommand.GetOutputDirectory(targetFramework: targetFramework, runtimeIdentifier: rid);
            var expectedFiles = new[] { "HelloWorld.dll" };

            if (publishSelfContained && !selfContainedIsGlobal)
                expectedFiles.Append("System.dll"); // System.dll should only exist if self contained 

            publishedDirectory.Should().HaveFiles(expectedFiles);
        }


        [RequiresMSBuildVersionTheory("17.5.0.0")] // This needs _IsPublishing to be set in MSBuild to pass.
        [InlineData("net7.0")]
        public void PublishSelfContainedPropertyDoesNotOverrideGlobalSelfContainProperty(string targetFramework)
        {
            var rid = EnvironmentInfo.GetCompatibleRid(targetFramework);

            var testAsset = _testAssetsManager
            .CopyTestAsset("HelloWorld")
            .WithSource()
            .WithProjectChanges(project =>
            {
                var ns = project.Root.Name.Namespace;
                var propertyGroup = project.Root.Elements(ns + "PropertyGroup").First();
                propertyGroup.Add(new XElement(ns + "PublishSelfContained", "true"));
            });

            var publishCommand = new PublishCommand(testAsset);
            var publishResult = publishCommand.Execute($"/p:RuntimeIdentifier={rid}", "/p:SelfContained=false");

            publishResult.Should().Pass();

            var publishDirectory = publishCommand.GetOutputDirectory(
                targetFramework: targetFramework,
                runtimeIdentifier: rid);
            publishDirectory.Should().HaveFiles(new[] {
                "HelloWorld.dll",
                "System.dll"  // File that should only exist if self contained 
            });
        }

        [Theory]
        [InlineData("--sc=false")]
        [InlineData("--self-contained=false")]
        [InlineData("--no-self-contained")]
        public void ItPublishesFrameworkDependentWithRid(string args)
        {
            var testAppName = "MSBuildTestApp";
            var rid = EnvironmentInfo.GetCompatibleRid();
            var outputDirectory = PublishApp(testAppName, rid, args);

            outputDirectory.Should().OnlyHaveFiles(new[] {
                $"{testAppName}{Constants.ExeSuffix}",
                $"{testAppName}.dll",
                $"{testAppName}.pdb",
                $"{testAppName}.deps.json",
                $"{testAppName}.runtimeconfig.json",
            });

            var outputProgram = Path.Combine(outputDirectory.FullName, $"{testAppName}{Constants.ExeSuffix}");

            var command = new RunExeCommand(Log, outputProgram);
            command.Execute()
                .Should()
                .Pass()
                .And
                .HaveStdOutContaining("Hello World");
        }

        [Theory]
        [InlineData("--sc=false")]
        [InlineData("--self-contained=false")]
        [InlineData(null)]
        [InlineData("--no-self-contained")]
        public void ItPublishesFrameworkDependentWithoutRid(string args)
        {
            var testAppName = "MSBuildTestApp";
            var outputDirectory = PublishApp(testAppName, rid: null, args: args);

            outputDirectory.Should().OnlyHaveFiles(new[] {
                $"{testAppName}{Constants.ExeSuffix}",
                $"{testAppName}.dll",
                $"{testAppName}.pdb",
                $"{testAppName}.deps.json",
                $"{testAppName}.runtimeconfig.json",
            });

            new DotnetCommand(Log)
                .Execute(Path.Combine(outputDirectory.FullName, $"{testAppName}.dll"))
                .Should().Pass()
                     .And.HaveStdOutContaining("Hello World");
        }

        [Theory]
        [InlineData("--sc --no-self-contained")]
        [InlineData("--self-contained --no-self-contained")]
        [InlineData("--sc=true --no-self-contained")]
        [InlineData("--self-contained=true --no-self-contained")]
        public void ItFailsToPublishWithConflictingArgument(string args)
        {
            var testAppName = "MSBuildTestApp";
            var rid = EnvironmentInfo.GetCompatibleRid();

            var testInstance = _testAssetsManager.CopyTestAsset(testAppName, identifier: args)
                .WithSource();

            var testProjectDirectory = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithRuntime(rid)
                .WithWorkingDirectory(testProjectDirectory)
                .Execute(args.Split())
                .Should().Fail()
                    .And.HaveStdErrContaining(CommonLocalizableStrings.SelfContainAndNoSelfContainedConflict);
        }

        private DirectoryInfo PublishApp(string testAppName, string rid, string args = null, [CallerMemberName] string callingMethod = "")
        {
            var testInstance = _testAssetsManager.CopyTestAsset(testAppName, callingMethod: callingMethod, identifier: $"{rid ?? "none"}_{args ?? "none"}")
                .WithSource();

            var testProjectDirectory = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithRuntime(rid)
                .WithWorkingDirectory(testProjectDirectory)
                .Execute(args?.Split() ?? Array.Empty<string>())
                .Should().Pass();

            var configuration = Environment.GetEnvironmentVariable("CONFIGURATION") ?? _defaultConfiguration;
            return new DirectoryInfo(Path.Combine(testProjectDirectory, "bin", configuration, ToolsetInfo.CurrentTargetFramework, rid ?? "", "publish"));
        }

        [Fact]
        public void ItPublishesAppWhenRestoringToSpecificPackageDirectory()
        {
            string dir = "pkgs";
            string args = $"--packages {dir}";

            var testInstance = _testAssetsManager.CopyTestAsset("TestAppSimple")
                .WithSource()
                .Restore(Log);

            var rootDir = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(rootDir)
                .Execute("--no-restore")
                .Should().Pass();

            var configuration = Environment.GetEnvironmentVariable("CONFIGURATION") ?? _defaultConfiguration;

            var outputProgram = Path.Combine(rootDir, "bin", configuration, ToolsetInfo.CurrentTargetFramework, "publish", $"TestAppSimple.dll");

            new DotnetCommand(Log, outputProgram)
                .Execute()
                .Should().Pass()
                     .And.HaveStdOutContaining("Hello World");
        }

        [Fact]
        public void ItFailsToPublishWithNoBuildIfNotPreviouslyBuilt()
        {
            var testInstance = _testAssetsManager.CopyTestAsset("TestAppSimple")
                .WithSource()
                .Restore(Log);

            var rootPath = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(rootPath)
                .Execute("--no-build")
                .Should()
                .Fail()
                .And.HaveStdOutContaining("MSB3030"); // "Could not copy ___ because it was not found."
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void ItPublishesSuccessfullyWithNoBuildIfPreviouslyBuilt(bool selfContained)
        {
            var testInstance = _testAssetsManager.CopyTestAsset("TestAppSimple", identifier: selfContained.ToString())
                .WithSource();

            var rootPath = testInstance.Path;

            var rid = selfContained ? EnvironmentInfo.GetCompatibleRid() : "";
            var ridArgs = selfContained ? $"-r {rid}".Split() : Array.Empty<string>();

            new DotnetBuildCommand(Log, rootPath)
                .Execute(ridArgs)
                .Should()
                .Pass();

            new DotnetPublishCommand(Log, "--no-build")
                .WithWorkingDirectory(rootPath)
                .Execute(ridArgs)
                .Should()
                .Pass();

            var configuration = Environment.GetEnvironmentVariable("CONFIGURATION") ?? _defaultConfiguration;

            var outputProgram = Path.Combine(rootPath, "bin", configuration, ToolsetInfo.CurrentTargetFramework, rid, "publish", $"TestAppSimple.dll");

            new DotnetCommand(Log, outputProgram)
                .Execute()
                .Should()
                .Pass()
                .And.HaveStdOutContaining("Hello World");
        }

        [Fact]
        public void ItFailsToPublishWithNoBuildIfPreviouslyBuiltWithoutRid()
        {
            var testInstance = _testAssetsManager.CopyTestAsset("TestAppSimple")
                .WithSource();

            var rootPath = testInstance.Path;

            new BuildCommand(testInstance)
                .Execute()
                .Should()
                .Pass();

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(rootPath)
                .Execute("-r", "win-x64", "--no-build")
                .Should()
                .Fail();
        }

        [Fact]
        public void DotnetPublishDoesNotPrintCopyrightInfo()
        {
            var testInstance = _testAssetsManager.CopyTestAsset("MSBuildTestApp")
                .WithSource();

            var cmd = new DotnetPublishCommand(Log)
               .WithWorkingDirectory(testInstance.Path)
               .Execute("--nologo");

            cmd.Should().Pass();

            if (!TestContext.IsLocalized())
            {
                cmd.Should().NotHaveStdOutContaining("Copyright (C) Microsoft Corporation. All rights reserved.");
            }
        }

        [Fact]
        public void DotnetPublishAllowsPublishOutputDir()
        {
            var testInstance = _testAssetsManager.CopyTestAsset("TestAppSimple")
                .WithSource()
                .Restore(Log);

            var rootDir = testInstance.Path;

            new DotnetPublishCommand(Log)
                .WithWorkingDirectory(rootDir)
                .Execute("--no-restore", "-o", "publish")
                .Should()
                .Pass();
        }


        [Fact]
        public void A_PublishRelease_property_does_not_override_other_command_configuration()
        {
            var helloWorldAsset = _testAssetsManager
               .CopyTestAsset("HelloWorld", "PublishPropertiesHelloWorld")
               .WithSource();

            System.IO.File.WriteAllText(helloWorldAsset.Path + "/Directory.Build.props", "<Project><PropertyGroup><PublishRelease>true</PublishRelease></PropertyGroup></Project>");

            new BuildCommand(helloWorldAsset)
               .Execute()
               .Should()
               .Pass();

            // Another command, which should not be affected by PublishRelease
            var packCommand = new DotnetPackCommand(Log, helloWorldAsset.TestRoot);

            packCommand
                .Execute()
                .Should()
                .Pass();

            var expectedAssetPath = System.IO.Path.Combine(helloWorldAsset.Path, "bin", "Release", "HelloWorld.1.0.0.nupkg");
            Assert.False(File.Exists(expectedAssetPath));
        }
    }
}
