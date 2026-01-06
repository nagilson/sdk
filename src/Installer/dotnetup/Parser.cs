// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.CommandLine.Completions;
using System.Text;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.Dotnet;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.Sdk;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.Sdk.Install;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.Sdk.Update;

namespace Microsoft.DotNet.Tools.Bootstrapper
{
    internal class Parser
    {
        public static ParserConfiguration ParserConfiguration { get; } = new()
        {
            EnablePosixBundling = false,
            //ResponseFileTokenReplacer = TokenPerLine
        };

        public static InvocationConfiguration InvocationConfiguration { get; } = new()
        {
            //EnableDefaultExceptionHandler = false,
        };

        public static ParseResult Parse(string[] args)
        {
            var normalizedArgs = NormalizeAliases(args);
            return RootCommand.Parse(normalizedArgs, ParserConfiguration);
        }
        public static int Invoke(ParseResult parseResult) => parseResult.Invoke(InvocationConfiguration);

        private static RootCommand RootCommand { get; } = ConfigureCommandLine(new()
        {
            Directives = { new DiagramDirective(), new SuggestDirective(), new EnvironmentVariablesDirective() }
        });

        private static string[] NormalizeAliases(string[] args)
        {
            if (args.Length == 0)
            {
                return args;
            }

            if (string.Equals(args[0], "do", StringComparison.OrdinalIgnoreCase))
            {
                var normalized = (string[])args.Clone();
                normalized[0] = "dotnet";
                return normalized;
            }

            return args;
        }

        private static RootCommand ConfigureCommandLine(RootCommand rootCommand)
        {
            rootCommand.Subcommands.Add(DotnetCommandParser.GetCommand());
            rootCommand.Subcommands.Add(SdkCommandParser.GetCommand());
            rootCommand.Subcommands.Add(SdkInstallCommandParser.GetRootInstallCommand());
            rootCommand.Subcommands.Add(SdkUpdateCommandParser.GetRootUpdateCommand());

            return rootCommand;
        }
    }
}
