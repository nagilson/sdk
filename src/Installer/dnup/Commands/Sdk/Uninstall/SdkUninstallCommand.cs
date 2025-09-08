// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.CommandLine;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace Microsoft.DotNet.Tools.Bootstrapper.Commands.Sdk.Uninstall
{
    internal class SdkUninstallCommand : CommandBase
    {
        private readonly string _version;
        private readonly InstallArchitecture _architecture;
        private readonly string _installPath;

        public SdkUninstallCommand(ParseResult parseResult) : base(parseResult)
        {
            _version = parseResult.GetValue(SdkUninstallCommandParser.VersionOption)!;
            _architecture = parseResult.GetValue(SdkUninstallCommandParser.ArchitectureOption);
            _installPath = Path.GetFullPath(parseResult.GetValue(SdkUninstallCommandParser.InstallPathOption)!);
        }

        public override int Execute()
        {
            try
            {
                DotnetVersion? resolvedVersion = null;
                
                // If the version is a channel (like 6.0 or 7.0.1xx), resolve it to a specific version
                if (_version.Contains('.') && !DotnetVersion.TryParse(_version, out _))
                {
                    var resolver = new ManifestChannelVersionResolver();
                    var installRequest = new DotnetInstallRequest(
                        _version,
                        _installPath,
                        InstallType.User,
                        InstallMode.SDK,
                        _architecture,
                        new ManagementCadence(ManagementCadenceType.DNUP),
                        new InstallRequestOptions());
                    
                    try
                    {
                        var install = resolver.Resolve(installRequest);
                        resolvedVersion = install.FullySpecifiedVersion;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"Error resolving version {_version}: {ex.Message}");
                        return 1;
                    }
                }
                else if (DotnetVersion.TryParse(_version, out var parsedVersion))
                {
                    resolvedVersion = parsedVersion;
                }
                else
                {
                    Console.WriteLine($"Invalid version format: {_version}");
                    return 1;
                }
                
                if (resolvedVersion is null)
                {
                    Console.WriteLine($"Unable to resolve version {_version}");
                    return 1;
                }
                
                // Create the DotnetInstall object for uninstallation
                var installToRemove = new DotnetInstall(
                    resolvedVersion.Value,
                    _installPath,
                    InstallType.User,
                    InstallMode.SDK,
                    _architecture,
                    new ManagementCadence(ManagementCadenceType.DNUP));
                
                // Check if the dotnet install path exists
                if (!Directory.Exists(_installPath))
                {
                    Console.WriteLine($"The specified install path does not exist: {_installPath}");
                    return 1;
                }
                
                Console.WriteLine($"Uninstalling .NET SDK {resolvedVersion.Value} from {_installPath}...");
                
                bool success = InstallerOrchestratorSingleton.Instance.Uninstall(installToRemove);
                
                if (success)
                {
                    Console.WriteLine($"Successfully uninstalled .NET SDK {resolvedVersion.Value}.");
                    return 0;
                }
                else
                {
                    Console.WriteLine($"Failed to uninstall .NET SDK {resolvedVersion.Value}.");
                    return 1;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error uninstalling .NET SDK: {ex.Message}");
                return 1;
            }
        }
    }
}
