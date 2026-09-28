##### Definitions

A shared lock is held via:

```cs
FileStream sharedLock = new(
    lockPath,
    FileMode.OpenOrCreate,
    FileAccess.Read,
    FileShare.Read);
```

An exclusive lock is held via:

```cs
FileStream exclusiveLock = new(
    lockPath,
    FileMode.OpenOrCreate,
    FileAccess.ReadWrite,
    FileShare.None);
```

`FileShare.Delete` is never requested on `A` or `U`.

`install`, `uninstall`, `update`, and the other manifest-mutating commands continue to use the `ModifyInstallationStates` mutex for their own critical sections. `P` does not acquire `ModifyInstallationStates`, and no modification to that logic is necessary.

##### Algorithm 1 — Lock acquisition and the `non-safe` gate

[ScopedLockFile](../../../../src/Installer/Microsoft.Dotnet.Installation/Internal/ScopedLockFile.cs) uses runtime `FileStream` sharing: an acquisition returns a lease, returns null for recognized contention, or propagates another I/O failure. The coordinator orchestrates retries using [LockFileRetryPolicy](../../../../src/Installer/Microsoft.Dotnet.Installation/Internal/LockFileRetryPolicy.cs) for cumulative contention accounting and bounded backoff; there is no additional native `flock` or lock-enforcement probe. These guarantees assume functioning runtime locks on a supported local filesystem, not bounded I/O latency on every filesystem.

###### Lock Acquisition for `N`

**1.3 — `N` passes the gate.**

Safety is a property of the command: `CommandBase` classifies every command as `non-safe` by default, and only `dotnetup dotnet`, the telemetry drain, and `self update` override that default. A newly added command is therefore gated unless someone deliberately exempts it.

**1.6 — Work permitted before the gate.**

Root telemetry, the first-run telemetry notice, and its sentinel are permitted before the gate. [CommandBase.Execute](../../../../src/Installer/dotnetup.Library/CommandBase.cs) enters the gate before option telemetry or the command body. Program owns the root and catches startup failures, including encoding-scope creation and disposal failures; SelfUpdateInvocation owns coordination and leases only. A rejected command may write telemetry and the notice sentinel, but never runs its body or cleanup. Parser-only actions have no command gate; the identity action also skips telemetry, console setup, and the notice. Program preserves the parser's action precedence when identity and other arguments are combined. Acquired invocation leases survive command completion, root telemetry completion, and synchronous `FlushTelemetry`, and are disposed only as `Main` returns.

##### Algorithm 2 — The update transaction

`Execute` requires a non-null lease-owner callback. Ownership transfers when that callback returns successfully; if it throws, the workflow disposes the acquired locks. Tests that need locks released when execution ends use the test-only [SelfUpdateTestWorkflow.ExecuteAndReleaseLocks](../../../../test/dotnetup.Tests/Utilities/SelfUpdateTestWorkflow.cs) wrapper. Production has no optional workflow-scoped lock lifetime.

**2.3 — `P` stages and validates the replacement.**

Permissions use ordinary runtime filesystem behavior, as SDK/runtime extraction does in [DotnetArchiveExtractor](../../../../src/Installer/Microsoft.Dotnet.Installation/Internal/DotnetArchiveExtractor.cs). On Windows, new staging files inherit their directory's permissions, and `File.Replace` preserves the installed executable's ACL. On Unix, archive extraction preserves archive modes; the raw dotnetup download has no archive mode, so `SelfUpdateWorkflow` copies the installed executable's mode with `File.GetUnixFileMode` and `File.SetUnixFileMode` rather than assigning a new fixed mode. Self-update does not add an owner whitelist, reject group-writable installs, or rewrite directory permissions.

[SelfUpdatePaths](../../../../src/Installer/dotnetup.Library/SelfUpdate/SelfUpdatePaths.cs) owns sibling naming, checked file access, and absence checks. `OpenFile` checks directories, devices, and links/reparse points before opening with `FileShare.Read | FileShare.Delete`. `Exists` treats only missing paths as absent, rather than hiding access errors or occupied directories. These checks are not atomic with subsequent operations. Directory handles are not pinned, ownership and hard-link counts are not inspected, and hostile concurrent path substitution is outside this model. The update locks coordinate participating dotnetup processes, not arbitrary filesystem writers.

**2.5 — `P` handles replacement failure.**

The workflow creates one `SelfUpdateReplacement` instance with the paths, backup name, and authoritative original identity. `Replace()` verifies that original identity and records the staged identity before mutation. Both immediate failure recovery and later `Rollback()` use that instance's fields; there is no global transaction table or recovery state attached to the paths object. Independent transactions may share the same `SelfUpdatePaths` without overwriting each other's evidence. A newly constructed transaction cannot roll back an occupied candidate it never recorded, but it can restore a verified original backup to an absent canonical path.

[Replacement recovery tests](../../../../test/dotnetup.Tests/SelfUpdateReplacementTests.cs) inject failures at the Windows replacement operation inside `Replace`, after validation, flushing, and transaction-state recording. They arrange the documented name states for errors 1175, 1176, and 1177 (with a backup specified), plus an ordinary unchanged-state error, before throwing into the production recovery handler. Additional cases exercise a failure after switching the canonical name and recovery blocked by a locked backup, an unknown canonical identity, or a wrong backup identity. Assertions cover real file restoration or preservation, both held locks, and retained failure details. These are deterministic state simulations, not a claim that the tests force Windows itself to return every partial-failure code.

**2.6 — `P` verifies the replacement.**

`--build-identity` is a hidden **option** on the root command, not a subcommand. Like the built-in `--version`, the action of `--build-identity` runs during `ParseResult.Invoke` and returns before any `CommandBase` is constructed, so `--build-identity` never reaches the gate of step 1.3. That is load-bearing rather than incidental: `P` holds both `A` and `U` exclusively while the child runs, so a gated child would block on its own opens and every transaction would fail. If the verification path ever becomes a subcommand, that subcommand must be classified `safe`.

`--build-identity` writes only `DotnetupBuildIdentity.Current`, read from the loaded record, to stdout. It does not reopen the executable on disk. This is the same ID used by step 1.4; `Parser.Version` remains the human-readable version. `--build-identity` disables telemetry and spawns no detached child processes. This execution check remains necessary even though the gate reads identities offline.

**2.8 — `P` rolls back.**

[Workflow tests](../../../../test/dotnetup.Tests/SelfUpdateWorkflowTests.cs) inject a reported kill error or termination timeout through the existing verification hook and exercise real file rollback and lock retention. This tests the recovery policy without launching an unkillable process; it does not test an operating-system termination failure itself.

## Linux:

Linux permits the pathname of a running executable to be replaced while the process continues executing the old inode. Algorithm 1 applies unchanged. Algorithm 2 applies with the Windows replacement and failure handling of steps 2.4 and 2.5 replaced by the hard-link-and-move sequence below, and the rollback of step 2.8 replaced by a move of the backup back over the canonical path. Step 1.4 uses the same embedded build-ID format and offline reader as Windows, not device/inode identity.

Let `D/dotnetup` be the installed executable, `D/dotnetup.new` the staged replacement, and `D/dotnetup.old.<t>` the backup.

`P` stages and validates `D/dotnetup.new` per step 2.3, preserves the installed executable's Unix mode, and flushes `D/dotnetup.new` to disk. `P` rejects unexpected symbolic links observed during pathname validation and operates on the canonical install path. `P` then creates `D/dotnetup.old.<t>` as a hard link to `D/dotnetup` and performs a same-filesystem move of `D/dotnetup.new` over `D/dotnetup`. `P` runs `D/dotnetup --build-identity` per step 2.6; otherwise `P` moves `D/dotnetup.old.<t>` back over `D/dotnetup`. Step 2.9 governs cleanup of `D/dotnetup.old.*` on later launches, including exclusive nonblocking acquisition of `U`.

The Unix forward switch uses the same managed `File.CreateHardLink` and `File.Move` APIs available to the rest of the installer. No dotnetup-specific `libc` imports or platform-specific native metadata layouts are needed.

A same-directory hard link preserves the old inode before replacement. Both the backup and the staged path must be on the same mounted filesystem as the installed executable.
The implemented operations are in [SelfUpdateReplacement](../../../../src/Installer/dotnetup.Library/SelfUpdate/SelfUpdateReplacement.cs). Rollback verifies the backup and any occupied canonical identity before restoring it with `File.Move(backupPath, installedPath, overwrite: true)`.

On a supported local Linux filesystem, new openers observe either the complete old inode or the complete new inode, while already-running processes continue using the old inode. The implementation flushes the staged file but does not perform a containing-directory durability sync or claim persistence across power loss.

Cross-filesystem `File.Move` may degrade to copy/delete behavior. Keeping all transaction files as siblings in a stable directory avoids that scenario; this is a layout requirement, not a custom native rename guarantee.

The rollback move restores the old executable and its build ID. Step 1.4 permits an `N` loaded from that build to proceed and rejects or forwards one loaded from the rejected build, exactly as on Windows.

#### Unix locking caveats

`A` and `U` do not carry the same weight on Unix as on Windows, and Algorithm 1 is correspondingly weaker there.

`FileShare` is mandatory on Windows and enforced by the kernel at `CreateFile`. On Unix, .NET implements `FileShare` with advisory `flock`, which binds only cooperating processes and can be disabled outright by the `System.IO.DisableFileLocking` AppContext switch or the `DOTNET_SYSTEM_IO_DISABLEFILELOCKING` environment variable. Dotnetup accepts the same locking compatibility as the .NET runtime: it uses `FileStream` sharing directly, does not take an additional native `flock`, and does not detect or compensate for disabled or ineffective runtime locking. The concurrency guarantees assume working runtime locking and cooperating processes.

The reason `FileShare.Delete` is never requested does not carry to Unix either. Unlinking an open file is always permitted on Unix, so the hazard the rule exists to prevent — deleting a lock file and recreating it, leaving two processes holding "exclusive" access to different inodes — cannot be prevented by share mode. The mitigation is that `A` and `U` live in a directory owned by the current user and dotnetup never deletes them.

`flock` over NFS is historically unreliable. A `D/` on a network filesystem can silently degrade the gate.

Holder identification is deferred on all platforms. Dotnetup does not parse Linux `/proc/locks` or add a native locking layer.

## macOS:

The macOS implementation selects the same managed hard-link/move flow in [SelfUpdateReplacement](../../../../src/Installer/dotnetup.Library/SelfUpdate/SelfUpdateReplacement.cs). It uses the same embedded build-ID reader and runtime file-sharing locks, and preserves the installed Unix mode. macOS execution, APFS behavior, code-signing, and quarantine interactions remain unverified; Linux results are not proof of macOS behavior.

