﻿// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.CommandLine.Parsing;
using System.IO;
using System.Linq;
using Microsoft.Build.Execution;
using Microsoft.DotNet.Cli;
using Microsoft.DotNet.Cli.Utils;
using Parser = Microsoft.DotNet.Cli.Parser;
using Microsoft.VisualBasic.CompilerServices;
using System.Collections;
using System.Diagnostics;

namespace Microsoft.DotNet.Tools.Publish
{
    public class PublishCommand : RestoringCommand
    {
        private PublishCommand(
            IEnumerable<string> msbuildArgs,
            bool noRestore,
            string msbuildPath = null)
            : base(msbuildArgs, noRestore, msbuildPath)
        {
        }

        public static PublishCommand FromArgs(string[] args, string msbuildPath = null)
        {
            var parser = Parser.Instance;
            var parseResult = parser.ParseFrom("dotnet publish", args);
            return FromParseResult(parseResult);
        }

        public static PublishCommand FromParseResult(ParseResult parseResult, string msbuildPath = null)
        {
            parseResult.HandleDebugSwitch();
            parseResult.ShowHelpOrErrorIfAppropriate();

            var msbuildArgs = new List<string>()
            {
                "-target:Publish",
                "-property:_IsPublishing=true"
            };

            IEnumerable<string> slnOrProjectArgs = parseResult.GetValueForArgument(PublishCommandParser.SlnOrProjectArgument);
            

            CommonOptions.ValidateSelfContainedOptions(parseResult.HasOption(PublishCommandParser.SelfContainedOption),
                parseResult.HasOption(PublishCommandParser.NoSelfContainedOption));

            msbuildArgs.AddRange(parseResult.OptionValuesToBeForwarded(PublishCommandParser.GetCommand()));
            msbuildArgs.Add(GetAutomaticConfigurationIfSpecified(parseResult, PublishCommandParser.customDefaultConfigurationProperty,
                    slnOrProjectArgs, PublishCommandParser.ConfigurationOption) ?? String.Empty);
            msbuildArgs.AddRange(slnOrProjectArgs ?? Array.Empty<string>());

            bool noRestore = parseResult.HasOption(PublishCommandParser.NoRestoreOption)
                          || parseResult.HasOption(PublishCommandParser.NoBuildOption);

            return new PublishCommand(
                msbuildArgs,
                noRestore,
                msbuildPath);
        }

        /// <summary>
        /// Provide a CLI input to change configuration based on 
        /// a boolean that may or may not exist in the targeted project.
        /// <param name="defaultedConfigurationProperty">The boolean property to check the project for. Ex: PublishRelease</param>
        /// <param name="slnOrProjectArgs">The arguments or solution passed to a dotnet invocation.</param>
        /// <param name="configOption">The arguments passed to a dotnet invocation related to Configuration.</param>
        /// </summary>
        /// <returns>Returns a string such as -property:configuration=value for a projects desired config. May be empty string.</returns>
        public static string GetAutomaticConfigurationIfSpecified(
            ParseResult parseResult,
            string defaultedConfigurationProperty,
            IEnumerable<string> slnOrProjectArgs,
            Option<string> configOption)
        {
            ProjectInstance project = GetTargetedProject(parseResult, slnOrProjectArgs);
            
            if (project != null)
            {
                string releaseMode = "";
                string releasePropertyFlag = project.GetPropertyValue(defaultedConfigurationProperty);
                if (!string.IsNullOrEmpty(releasePropertyFlag))
                    releaseMode = releasePropertyFlag == "true" ? "Release" : "Debug";

                if (
                    !ConfigurationAlreadySpecified(parseResult, project, configOption) &&
                    !string.IsNullOrEmpty(releaseMode) &&
                    !slnOrProjectArgs.Any(arg => arg.Contains(defaultedConfigurationProperty))
                   )
                    return $"-property:configuration={releaseMode}";
            }
            return String.Empty;
        }

        private static ProjectInstance GetTargetedProject(ParseResult parseResult, IEnumerable<string> slnOrProjectArgs)
        {
            string potentialProject = "";
            foreach (string arg in slnOrProjectArgs)
            {
                if (File.Exists(arg) && LikeOperator.LikeString(arg, "*.*proj", VisualBasic.CompareMethod.Text))
                {
                    potentialProject = arg;
                    break;
                }
                else if(Directory.Exists(arg))
                {
                    List<string> projectFiles = Directory.EnumerateFileSystemEntries(arg, "*.*proj", SearchOption.TopDirectoryOnly).ToList();
                    if(projectFiles.Any())
                    {
                        potentialProject = projectFiles.First();
                        break;
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(potentialProject))
            {
                try
                {
                    potentialProject = MsbuildProject.GetProjectFileFromDirectory(Directory.GetCurrentDirectory()).Name;
                }
                catch (GracefulException)
                {
                    ; // MSBuild XMake::ProcessProjectSwitch will handle errors if projects for publish/build weren't discoverable.
                }
            }

            return string.IsNullOrEmpty(potentialProject) ? null : new ProjectInstance(potentialProject);
        }

        private static bool ConfigurationAlreadySpecified(ParseResult parseResult, ProjectInstance project, Option<string> configurationOption)
        {
            return parseResult.HasOption(configurationOption) || (project.GlobalProperties.ContainsKey("Configuration"));
        }

        public static int Run(ParseResult parseResult)
        {
            parseResult.HandleDebugSwitch();

            return FromParseResult(parseResult).Execute();
        }
    }
}
