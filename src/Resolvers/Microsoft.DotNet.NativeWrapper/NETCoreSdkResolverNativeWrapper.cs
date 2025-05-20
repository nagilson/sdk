// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;

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
                ? Interop.hostfxr_get_available_sdks(dotnetExeDirectory, list.Initialize)
                : Interop.Unix.hostfxr_get_available_sdks(dotnetExeDirectory, list.Initialize);

            return list.Entries;
        }

        public static InitializationRuntimeConfigResult GetFrameworks(string runtimeConfigPath)
        {
            string dotnetRoot = null;
            if (args.Length >= 2)
                dotnetRoot = args[1];

            List<Interop.hostfxr_resolve_frameworks_result> resolved = new();
            List<Interop.hostfxr_resolve_frameworks_result> unresolved = new();

            IntPtr resultContext = new IntPtr(123);

            Interop.hostfxr_resolve_frameworks_result_fn callback = (IntPtr resultPtr, IntPtr contextPtr) =>
            {
                Interop.hostfxr_resolve_frameworks_result result = Marshal.PtrToStructure<Interop.hostfxr_resolve_frameworks_result>(resultPtr);

                if (result.size != (nuint)sizeof(Interop.hostfxr_resolve_frameworks_result))
                    throw new Exception($"Unexpected {nameof(Interop.hostfxr_resolve_frameworks_result)}.size: {result.size}. Expected: {sizeof(Interop.hostfxr_resolve_frameworks_result)}.");

                if (contextPtr != resultContext)
                    throw new Exception($"Unexpected result_context value: {contextPtr}. Expected: {resultContext}.");

                for (int i = 0; i < (int)result.resolved_count; i++)
                {
                    nint ptr = result.resolved_frameworks + i * Marshal.SizeOf<Interop.hostfxr_framework_result>();
                    resolved.Add(Marshal.PtrToStructure<Interop.hostfxr_framework_result>(ptr));
                }

                for (int i = 0; i < (int)result.unresolved_count; i++)
                {
                    nint ptr = result.unresolved_frameworks + i * Marshal.SizeOf<Interop.hostfxr_framework_result>();
                    unresolved.Add(Marshal.PtrToStructure<Interop.hostfxr_framework_result>(ptr));
                }
            };

            int rc;
            Interop.hostfxr_initialize_parameters parameters = new()
            {
                size = (nuint)sizeof(Interop.hostfxr_initialize_parameters),
                host_path = IntPtr.Zero,
                dotnet_root = dotnetRoot != null ? Marshal.StringToCoTaskMemAuto(dotnetRoot) : IntPtr.Zero
            };
            try
            {
                rc = Interop.hostfxr_resolve_frameworks_for_runtime_config(
                    runtime_config_path: runtimeConfigPath,
                    parameters: parameters,
                    callback: callback,
                    result_context: resultContext);
            }
            finally
            {
                Marshal.FreeCoTaskMem(parameters.dotnet_root);
            }

        }
    }
