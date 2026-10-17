// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Microsoft.DotNet.Tools.Bootstrapper.WindowsInstaller;

/// <summary>
/// Asks a running WiX Burn bundle to cancel the way its own UI would: by posting <c>WM_CLOSE</c> to the bootstrapper
/// application's (BA's) hidden top-level window of class <see cref="BootstrapperApplicationWindowClass"/>.
/// </summary>
/// <remarks>
/// <para>
/// wixstdba handles <c>WM_CLOSE</c> in <c>OnClose()</c>. Under <c>/quiet</c> or <c>/passive</c> the cancel is forced,
/// so <c>PromptCancel</c> sets the canceled flag without prompting (wixtoolset/wix BootstrapperApplicationBase.h), and
/// while applying it keeps the window open and only cancels "to let rollback occur"
/// (WixStandardBootstrapperApplication.cpp, <c>OnClose</c>). Each later engine callback then returns cancel; during the
/// elevated MSI phase the cancel reaches Windows Installer's external UI handler, so MSI rolls back natively. The
/// engine exits with 1602 (<c>ERROR_INSTALL_USEREXIT</c>) and removes its extracted files. Burn acts on the cancel
/// only at its next callback, so the stop is not immediate.
/// </para>
/// <para>
/// Where the window lives depends on the Burn version: WiX v6 bundles (the runtime bundles) host the BA out of process
/// in a <c>wixstdba.exe</c> child of the engine, while WiX v5 bundles (the SDK bundle) may host it in the engine
/// process itself. The window is therefore searched among the engine process and all of its descendants.
/// </para>
/// <para>
/// Closing the engine's own window (<c>WixBurnMessageWindow</c>, the target of <c>Process.CloseMainWindow</c>) does not
/// cancel and destroys the window Burn uses to handle <c>WM_QUERYENDSESSION</c>, so only the BA window is targeted.
/// </para>
/// </remarks>
[SupportedOSPlatform("windows")]
internal static unsafe partial class BurnCancellation
{
    /// <summary>The window class registered by the WiX standard bootstrapper application.</summary>
    internal const string BootstrapperApplicationWindowClass = "WixStdBA";

    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint WM_CLOSE = 0x0010;
    private const int MaxClassNameLength = 256;

    /// <summary>
    /// Posts <c>WM_CLOSE</c> to the bootstrapper application windows owned by the engine process
    /// <paramref name="engineProcessId"/> or its descendants. Returns false when no such window was found or none
    /// accepted the message.
    /// </summary>
    public static bool RequestCancel(int engineProcessId)
    {
        HashSet<uint> processIds = GetProcessTree((uint)engineProcessId);

        bool posted = false;
        foreach (nint window in FindWindows(processIds, BootstrapperApplicationWindowClass))
        {
            posted |= PostMessageW(window, WM_CLOSE, 0, 0);
        }

        return posted;
    }

    /// <summary>Returns <paramref name="rootProcessId"/> and the IDs of all of its running descendants.</summary>
    internal static HashSet<uint> GetProcessTree(uint rootProcessId)
    {
        var processTree = new HashSet<uint> { rootProcessId };
        var childrenByParent = new Dictionary<uint, List<uint>>();
        nint snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == -1)
        {
            return processTree;
        }

        try
        {
            ProcessEntry32 entry = default;
            entry.Size = (uint)sizeof(ProcessEntry32);
            for (bool hasEntry = Process32FirstW(snapshot, &entry); hasEntry; hasEntry = Process32NextW(snapshot, &entry))
            {
                if (entry.ProcessId == entry.ParentProcessId)
                {
                    continue;
                }

                if (!childrenByParent.TryGetValue(entry.ParentProcessId, out List<uint>? children))
                {
                    childrenByParent[entry.ParentProcessId] = children = [];
                }

                children.Add(entry.ProcessId);
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }

        var pending = new Queue<uint>([rootProcessId]);
        while (pending.TryDequeue(out uint parent))
        {
            if (childrenByParent.TryGetValue(parent, out List<uint>? children))
            {
                foreach (uint child in children)
                {
                    if (processTree.Add(child))
                    {
                        pending.Enqueue(child);
                    }
                }
            }
        }

        return processTree;
    }

    /// <summary>Returns the top-level windows of class <paramref name="className"/> owned by <paramref name="processIds"/>.</summary>
    internal static List<nint> FindWindows(IReadOnlySet<uint> processIds, string className)
    {
        var search = new WindowSearch(processIds, className);
        GCHandle handle = GCHandle.Alloc(search);
        try
        {
            EnumWindows(&CollectMatchingWindow, GCHandle.ToIntPtr(handle));
        }
        finally
        {
            handle.Free();
        }

        return search.Matches;
    }

    [UnmanagedCallersOnly]
    private static int CollectMatchingWindow(nint window, nint state)
    {
        var search = (WindowSearch)GCHandle.FromIntPtr(state).Target!;
        uint processId;
        GetWindowThreadProcessId(window, &processId);
        if (search.ProcessIds.Contains(processId))
        {
            char* buffer = stackalloc char[MaxClassNameLength];
            int length = GetClassNameW(window, buffer, MaxClassNameLength);
            if (length > 0 && new ReadOnlySpan<char>(buffer, length).SequenceEqual(search.ClassName))
            {
                search.Matches.Add(window);
            }
        }

        return 1;
    }

    private sealed class WindowSearch(IReadOnlySet<uint> processIds, string className)
    {
        public IReadOnlySet<uint> ProcessIds { get; } = processIds;

        public string ClassName { get; } = className;

        public List<nint> Matches { get; } = [];
    }

    /// <summary>PROCESSENTRY32W.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public nuint DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        public fixed char ExeFile[260]; // MAX_PATH
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint CreateToolhelp32Snapshot(uint flags, uint processId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool Process32FirstW(nint snapshot, ProcessEntry32* entry);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool Process32NextW(nint snapshot, ProcessEntry32* entry);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(nint handle);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool EnumWindows(delegate* unmanaged<nint, nint, int> callback, nint state);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(nint window, uint* processId);

    [LibraryImport("user32.dll", SetLastError = true)]
    private static partial int GetClassNameW(nint window, char* className, int maxCount);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool PostMessageW(nint window, uint message, nint wParam, nint lParam);
}
