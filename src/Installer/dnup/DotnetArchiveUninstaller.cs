// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Microsoft.DotNet.Tools.Bootstrapper
{
    internal class DotnetArchiveUninstaller : IUninstaller, IDisposable
    {
        private readonly DotnetInstall _install;
        private readonly List<string> _directoriesToDelete = new();
        private bool _isValid = false;
        
        // These would ideally be properties on DotnetInstall
        private string? _runtimeVersion;
        private string? _aspNetVersion;
        private string? _windowsDesktopVersion;

        public DotnetArchiveUninstaller(DotnetInstall install)
        {
            _install = install;
        }

        public void Prepare()
        {
            try
            {
                // Check if the install exists in the manifest
                var manifestManager = new DnupSharedManifest();
                var existingInstalls = manifestManager.GetInstalledVersions(_install.MuxerDirectory);

                var matchingInstall = existingInstalls.FirstOrDefault(existing =>
                    existing.FullySpecifiedVersion.Value == _install.FullySpecifiedVersion.Value &&
                    existing.Type == _install.Type &&
                    existing.Architecture == _install.Architecture);

                if (matchingInstall == null)
                {
                    Console.WriteLine($".NET SDK {_install.FullySpecifiedVersion.Value} is not installed.");
                    _isValid = false;
                    return;
                }

                // Store component versions for use during uninstall
                // In a real implementation, these would be properties on DotnetInstall
                _runtimeVersion = GetComponentVersion(existingInstalls, matchingInstall, "Microsoft.NETCore.App");
                _aspNetVersion = GetComponentVersion(existingInstalls, matchingInstall, "Microsoft.AspNetCore.App");
                _windowsDesktopVersion = GetComponentVersion(existingInstalls, matchingInstall, "Microsoft.WindowsDesktop.App");

                // Check if SDK directories exist
                string sdkDir = Path.Combine(_install.MuxerDirectory, "sdk", _install.FullySpecifiedVersion.Value);
                if (Directory.Exists(sdkDir))
                {
                    _directoriesToDelete.Add(sdkDir);
                }

                // Identify runtime components that need to be deleted
                IdentifyRuntimeComponentsToDelete(existingInstalls);

                _isValid = true;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error preparing for uninstallation: {ex.Message}");
                _isValid = false;
            }
        }

        private string? GetComponentVersion(IEnumerable<DotnetInstall> allInstalls, DotnetInstall matchingInstall, string componentName)
        {
            // This is a mock implementation since we don't have the actual component version properties
            // In a real implementation, we would get these directly from the DotnetInstall object
            
            // For now, we'll use the SDK version as the component version
            // In reality, these would be different but related versions
            return matchingInstall.FullySpecifiedVersion.Value;
        }

        private void IdentifyRuntimeComponentsToDelete(IEnumerable<DotnetInstall> existingInstalls)
        {
            // Keep track of shared components that are still needed by other installs
            var runtimesInUse = new HashSet<string>();
            var aspNetInUse = new HashSet<string>();
            var windowsDesktopInUse = new HashSet<string>();

            // Collect versions still in use
            foreach (var install in existingInstalls)
            {
                if (install.FullySpecifiedVersion.Value != _install.FullySpecifiedVersion.Value)
                {
                    // We're using the SDK version as a proxy for component versions here
                    // In a real implementation, we would use the actual component versions
                    var installRuntimeVersion = GetComponentVersion(existingInstalls, install, "Microsoft.NETCore.App");
                    var installAspNetVersion = GetComponentVersion(existingInstalls, install, "Microsoft.AspNetCore.App");
                    var installWindowsDesktopVersion = GetComponentVersion(existingInstalls, install, "Microsoft.WindowsDesktop.App");
                    
                    if (installRuntimeVersion != null)
                    {
                        runtimesInUse.Add(installRuntimeVersion);
                    }
                    if (installAspNetVersion != null)
                    {
                        aspNetInUse.Add(installAspNetVersion);
                    }
                    if (installWindowsDesktopVersion != null)
                    {
                        windowsDesktopInUse.Add(installWindowsDesktopVersion);
                    }
                }
            }

            // Add runtime components to delete if they're not used by other installs
            if (_runtimeVersion != null && !runtimesInUse.Contains(_runtimeVersion))
            {
                string runtimeDir = Path.Combine(_install.MuxerDirectory, "shared", "Microsoft.NETCore.App", _runtimeVersion);
                if (Directory.Exists(runtimeDir))
                {
                    _directoriesToDelete.Add(runtimeDir);
                }

                string hostFxrDir = Path.Combine(_install.MuxerDirectory, "host", "fxr", _runtimeVersion);
                if (Directory.Exists(hostFxrDir))
                {
                    _directoriesToDelete.Add(hostFxrDir);
                }

                // For the host pack directory, determine the platform-specific path
                string rid = DnupUtilities.GetRuntimeIdentifier(_install.Architecture);
                string packsHostDir = Path.Combine(_install.MuxerDirectory, "packs", $"Microsoft.NETCore.App.Host.{rid}", _runtimeVersion);
                if (Directory.Exists(packsHostDir))
                {
                    _directoriesToDelete.Add(packsHostDir);
                }
            }

            // Add ASP.NET components to delete if they're not used by other installs
            if (_aspNetVersion != null && !aspNetInUse.Contains(_aspNetVersion))
            {
                string aspNetDir = Path.Combine(_install.MuxerDirectory, "shared", "Microsoft.AspNetCore.App", _aspNetVersion);
                if (Directory.Exists(aspNetDir))
                {
                    _directoriesToDelete.Add(aspNetDir);
                }

                string templatesDir = Path.Combine(_install.MuxerDirectory, "templates", _aspNetVersion);
                if (Directory.Exists(templatesDir))
                {
                    _directoriesToDelete.Add(templatesDir);
                }
            }

            // Add Windows Desktop components to delete if they're not used by other installs
            if (_windowsDesktopVersion != null && !windowsDesktopInUse.Contains(_windowsDesktopVersion))
            {
                string windowsDesktopDir = Path.Combine(_install.MuxerDirectory, "shared", "Microsoft.WindowsDesktop.App", _windowsDesktopVersion);
                if (Directory.Exists(windowsDesktopDir))
                {
                    _directoriesToDelete.Add(windowsDesktopDir);
                }
            }
        }

        public void Commit()
        {
            if (!_isValid)
            {
                throw new InvalidOperationException("Cannot commit uninstallation. Prepare() has not been called or validation failed.");
            }

            Spectre.Console.AnsiConsole.Progress()
                .Start(ctx =>
                {
                    var uninstallTask = ctx.AddTask($"Uninstalling .NET SDK {_install.FullySpecifiedVersion.Value}", autoStart: true);
                    
                    // Delete directories
                    int totalDirectories = _directoriesToDelete.Count;
                    uninstallTask.MaxValue = totalDirectories > 0 ? totalDirectories : 1;
                    
                    foreach (var dir in _directoriesToDelete)
                    {
                        Console.WriteLine($"Removing directory: {dir}");
                        try
                        {
                            Directory.Delete(dir, true);
                            uninstallTask.Increment(1);
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine($"Warning: Failed to delete directory {dir}: {ex.Message}");
                            uninstallTask.Increment(1);
                        }
                    }
                    
                    // Update manifest to remove the uninstalled version
                    DnupSharedManifest manifestManager = new();
                    manifestManager.RemoveInstalledVersion(_install);
                    
                    uninstallTask.Value = uninstallTask.MaxValue;
                });
        }

        public void Dispose()
        {
            // Cleanup any temporary resources if needed
        }
    }
}
