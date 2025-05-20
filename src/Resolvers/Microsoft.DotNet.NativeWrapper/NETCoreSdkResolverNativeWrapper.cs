// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;

namespace Microsoft.DotNet.NativeWrapper
{
    public static class NETCoreSdkResolverNativeWrapper
    {
        public static SdkResolutionResult ResolveSdk(
            string? dotnetExeDirectory,
            string? globalJsonStartDirectory,
            bool disallowPrerelease = false)
        {
            var result = new SdkResolutionResult();
            var flags = disallowPrerelease ? Interop.hostfxr_resolve_sdk2_flags_t.disallow_prerelease : 0;

            int errorCode = Interop.RunningOnWindows
                ? Interop.Windows.hostfxr_resolve_sdk2(dotnetExeDirectory, globalJsonStartDirectory, flags, result.Initialize)
                : Interop.Unix.hostfxr_resolve_sdk2(dotnetExeDirectory, globalJsonStartDirectory, flags, result.Initialize);

            Debug.Assert((errorCode == 0) == (result.ResolvedSdkDirectory != null));
            return result;
        }

        private sealed class SdkList
        {
            public string[]? Entries;

            public void Initialize(int count, string[] entries)
            {
                entries = entries ?? Array.Empty<string>();
                Debug.Assert(count == entries.Length);
                Entries = entries;
            }
        }

        public static string[]? GetAvailableSdks(string? dotnetExeDirectory)
        {
            var list = new SdkList();

            int errorCode = Interop.RunningOnWindows
                ? Interop.Windows.hostfxr_get_available_sdks(dotnetExeDirectory, list.Initialize)
                : Interop.Unix.hostfxr_get_available_sdks(dotnetExeDirectory, list.Initialize);

            return list.Entries;
        }

        public class RuntimeConfigFramework
        {
            public string Name { get; }
            public string Version { get; }
            public string Path { get; }

            public RuntimeConfigFramework(string name, string version, string path)
            {
                Name = name ?? throw new ArgumentNullException(nameof(name));
                Version = version ?? throw new ArgumentNullException(nameof(version));
                Path = path ?? throw new ArgumentNullException(nameof(path));
            }
        }

        /// <summary>
        /// Resolves the frameworks referenced in a runtime config file using hostfxr.
        /// </summary>
        /// <param name="runtimeConfigPath">Path to the runtime config JSON file.</param>
        /// <param name="additionalFrameworkPaths">Additional paths to search for frameworks.</param>
        /// <param name="frameworks">Array of resolved framework references.</param>
        /// <returns>True if frameworks were successfully resolved, false otherwise.</returns>
        public static bool TryResolveFrameworksForRuntimeConfig(
            string runtimeConfigPath,
            string[]? additionalFrameworkPaths,
            out RuntimeConfigFramework[] frameworks)
        {
            if (string.IsNullOrEmpty(runtimeConfigPath))
            {
                throw new ArgumentNullException(nameof(runtimeConfigPath));
            }

            var resolvedFrameworks = new List<RuntimeConfigFramework>();
            var resultContext = GCHandle.Alloc(resolvedFrameworks);

            try
            {
                void FrameworkResolvedCallback(IntPtr namePtr, IntPtr versionPtr, IntPtr pathPtr, IntPtr context)
                {
                    var frameworks = (List<RuntimeConfigFramework>)GCHandle.FromIntPtr(context).Target!;
                    string name = Marshal.PtrToStringUni(namePtr) ?? string.Empty;
                    string version = Marshal.PtrToStringUni(versionPtr) ?? string.Empty;
                    string path = Marshal.PtrToStringUni(pathPtr) ?? string.Empty;

                    frameworks.Add(new RuntimeConfigFramework(name, version, path));
                }

                additionalFrameworkPaths ??= Array.Empty<string>();
                int result = Interop.hostfxr_resolve_frameworks2(
                    runtimeConfigPath,
                    additionalFrameworkPaths,
                    additionalFrameworkPaths.Length,
                    FrameworkResolvedCallback,
                    GCHandle.ToIntPtr(resultContext));

                frameworks = resolvedFrameworks.ToArray();
                return result == 0 && frameworks.Length > 0;
            }
            finally
            {
                if (resultContext.IsAllocated)
                {
                    resultContext.Free();
                }
            }
        }
    }
}
