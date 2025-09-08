// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.CommandLine;
using System.IO;

namespace Microsoft.DotNet.Tools.Bootstrapper.Commands.Sdk.Uninstall
{
    internal static class SdkUninstallCommandParser
    {
        public static readonly Option<string> VersionOption = new("--version")
        {
            Description = "The version of the SDK to uninstall."
        };
        
        public static readonly Option<InstallArchitecture> ArchitectureOption = new("--architecture")
        {
            Description = "The architecture of the SDK to uninstall.",
            DefaultValueFactory = (_) => DnupUtilities.GetInstallArchitecture(System.Runtime.InteropServices.RuntimeInformation.OSArchitecture)
        };
        
        public static readonly Option<string> InstallPathOption = new("--install-path")
        {
            Description = "The path to the dotnet installation to uninstall from.",
            DefaultValueFactory = (_) => new BootstrapperController().GetDefaultDotnetInstallPath()
        };
        
        private static readonly Command SdkUninstallCommand = ConstructCommand();
        
        public static Command GetSdkUninstallCommand()
        {
            return SdkUninstallCommand;
        }
        
        private static Command ConstructCommand()
        {
            Command command = new("uninstall", "Uninstall .NET SDK.");
            
            command.Options.Add(VersionOption);
            command.Options.Add(ArchitectureOption);
            command.Options.Add(InstallPathOption);
            
            command.SetAction(parseResult => new SdkUninstallCommand(parseResult).Execute());
            
            return command;
        }
    }
}
