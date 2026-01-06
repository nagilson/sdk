// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.CommandLine;

namespace Microsoft.DotNet.Tools.Bootstrapper.Commands.Dotnet;

internal static class DotnetCommandParser
{
    public static readonly Option<string?> ManifestPathOption = new("--manifest-path")
    {
        HelpName = "MANIFEST_PATH",
        Description = "Path to the dotnetup manifest file to use when locating managed installations.",
        Arity = ArgumentArity.ZeroOrOne
    };

    private static readonly Command DotnetCommand = ConstructCommand();

    public static Command GetCommand() => DotnetCommand;

    private static Command ConstructCommand()
    {
        var command = new Command("dotnet", "Run dotnet from the dotnetup-managed installation.");
        command.Options.Add(ManifestPathOption);
        command.TreatUnmatchedTokensAsErrors = false;
        command.SetAction(parseResult => new DotnetForwardCommand(parseResult).Execute());

        return command;
    }
}
