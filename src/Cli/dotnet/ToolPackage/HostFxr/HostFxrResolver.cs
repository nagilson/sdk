using System.Runtime.InteropServices;

namespace Microsoft.DotNet.Cli.ToolPackage;

internal static class HostFxrResolver
{
    private const string HostFxrName = "hostfxr";

    [DllImport(HostFxrName, CharSet = CharSet.Unicode)]
    private static extern int hostfxr_resolve_frameworks_for_runtime_config(
        string runtime_config_path,
        IntPtr buffer,
        int buffer_size,
        out IntPtr required_buffer_size);

    public static bool TryResolveFrameworksForRuntimeConfig(string runtimeConfigPath, out RuntimeConfigFramework[] frameworks)
    {
        frameworks = Array.Empty<RuntimeConfigFramework>();

        // First call to get required buffer size
        int rc = hostfxr_resolve_frameworks_for_runtime_config(
            runtimeConfigPath,
            IntPtr.Zero,
            0,
            out IntPtr requiredSize);

        if (rc != 0 || requiredSize == IntPtr.Zero)
        {
            return false;
        }

        // Allocate buffer and make second call
        IntPtr buffer = Marshal.AllocHGlobal(requiredSize.ToInt32());
        try
        {
            rc = hostfxr_resolve_frameworks_for_runtime_config(
                runtimeConfigPath,
                buffer,
                requiredSize.ToInt32(),
                out _);

            if (rc != 0)
            {
                return false;
            }

            // Parse the native buffer into framework objects
            frameworks = ParseFrameworkBuffer(buffer);
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static RuntimeConfigFramework[] ParseFrameworkBuffer(IntPtr buffer)
    {
        // The buffer contains a count followed by framework entries
        int count = Marshal.ReadInt32(buffer);
        var frameworks = new RuntimeConfigFramework[count];

        IntPtr current = buffer + sizeof(int);
        for (int i = 0; i < count; i++)
        {
            // Read framework name
            string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(current));
            current += IntPtr.Size;

            // Read version
            string version = Marshal.PtrToStringUni(Marshal.ReadIntPtr(current));
            current += IntPtr.Size;

            frameworks[i] = new RuntimeConfigFramework(name, Version.Parse(version));
        }

        return frameworks;
    }
}

internal class RuntimeConfigFramework
{
    public string Name { get; }
    public Version Version { get; }

    public RuntimeConfigFramework(string name, Version version)
    {
        Name = name;
        Version = version;
    }
}
