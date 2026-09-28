# Self Update

`dotnetup self update [--no-progress]` updates the published NativeAOT `dotnetup`
executable in place. Stage A is implemented; waiting and transparent forwarding of
ordinary commands remain Stage B work. See the [stage success criteria](self-update-stages.md),
[algorithm](self-update-algorithm.md), and
[implementation details](self-update-algorithm-implementations.md).

The current command resolves the daily release for the selected RID. It does not
accept a channel or version argument. See [command usage](../reference/dotnetup.md#self-update).

`dotnetup update` already updates all of the installs managed by dotnetup. Using `self update` as the key noun matches `dotnetup sdk update` nomenclature. `dotnetup update` will continue to update only the .NET SDK and .NET Runtime installs.

# Trade-offs

On Windows, `dotnetup` can pick one approach:

1. Reboot Approach:

To require a reboot to update and replace. This simplifies logic because replacement can occur before the executable is loaded, and it provides stronger recovery options through the installer. It is a poor experience for a developer tool.

2. `MoveFileExW` Approach:

`MoveFileExW(stagedPath, installedPath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` can move a staged executable over the canonical path in one call after the canonical executable is no longer running. `MOVEFILE_WRITE_THROUGH` asks Windows not to return until the move has completed on disk, but it does not make the operation an ACID transaction or provide a documented all-or-nothing guarantee across power loss.

Because replacing the still-running destination with `MoveFileExW` cannot be relied upon, this approach requires a temporary replacer process outside `D/`, a handoff from the original process, and draining every process that has the canonical executable open incompatibly. `MoveFileExW` also does not create a backup as part of the move, so preserving the old executable requires a separate operation.

3. `File.Replace` / `ReplaceFileW` Approach:

`File.Replace(stagedPath, installedPath, backupPath)` maps to the Windows `ReplaceFileW` API. It combines replacement of the canonical path and creation of a backup in one operating-system call. Windows permits this operation while the old executable image is running when existing handles allow delete sharing; the running process continues executing the old image while future launches resolve the replacement.

This avoids deliberately splitting the forward replacement into two `File.Move` calls; it does not guarantee an uninterrupted canonical name. Windows measurements observed a brief file-not-found interval even within `File.Replace`, so consumers must retry transient launch failures. It is not an ACID or power-loss-safe transaction: `ReplaceFileW` documents partial failure states, and its `REPLACEFILE_WRITE_THROUGH` flag is unsupported. The staged executable is flushed before replacement, and recovery accounts for the staged, canonical, and backup paths after failure. See [replacement properties](self-update-algorithm.md#properties-of-algorithms-1-and-2).


### Cross Update Boundary Trade-Offs

Allowing `dotnetup runtime install` to run across either replacement operation remains unsafe because old code may encounter installation state written by a newer manifest format. The activity gate described in the [self-update algorithm](self-update-algorithm.md#algorithm-1--lock-acquisition-and-the-non-safe-gate) excludes those `non-safe` processes while allowing explicitly `safe` processes to continue running.

Existing safe processes may still change behavior if they resolve paths or load external assets after replacement, so every safe process must cache values derived from its loaded image at startup.

## Selected Approach
For `dotnetup`, `3` is the best selection.

For `1`, requiring a reboot would interrupt developers, and dotnetup is a developer tool; a reboot-style approach is best served for system level applications or applications managed by IT.

For `2`, the temporary replacer and process-draining protocol add a handoff without producing a transactional power-loss guarantee. `MOVEFILE_WRITE_THROUGH` improves completion durability but does not remove the need for an independently created backup or recovery logic.

For `3`, no separate replacer is needed. The original process can call `File.Replace` against its own canonical path, retain the update locks through verification and rollback, and allow explicitly safe processes such as the telemetry drainer to continue executing their already-loaded image. IDEs or other tools may also invoke unattended updates concurrently; the update lock serializes those callers.

To clarify, this does not mean that updates to dotnetup itself execute concurrently. Racing update commands wait for the update lock, re-evaluate the installed identity after acquiring both locks, and exit successfully when no update remains to apply.

`dotnetup` is easily and quickly re-installed via the script if an outage occurs.

#### Concurrency Trade-Offs

Another contention is whether to have mutex or inter-process (i.e. several process) aware logic; should `dotnetup` gracefully succeed when multiple updates are attempted at once or simply reject the premise and fail?

`Aspire` and `rustup` are not concurrency safe during update procedures and they also do not block such an action explicitly.

`dotnetup` should be concurrency safe. `dotnetup` should also allow multiple callers to invoke it at the same time to configure/install runtimes, so it should not run an exclusive lock on itself at all times as this would delay progress and other apps unnecessarily.

# Update As a Version Swap Mechanism

Version/channel selection, downgrade commands, and `self install` are future design possibilities, not registered CLI surfaces. The current parser accepts only daily `self update` and its `--no-progress` option. Use the existing [installation guidance](https://aka.ms/dotnet/dotnetup) for older versions.

# Release Stable VS Preview

Future signed self-update would resolve an index of dotnetup releases similar to the .NET release manifest. This is not the current daily resolver.
The manifest will be signed just like the .NET artifacts manifests, with a detached signature, which will be downloaded as well and be used to validate dotnetup's own executable. We could only have an index but supporting multiple versions or allowing a downgrade/revert will only be possible if we maintain separate indexes. Whether we have a `daily` `preview` `stable` keyed index or a `major.minor` keyed index is not part of this spec.

#### Comparisons

`rustup` - Rustup [downloads and launches a separate updater](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update.rs), but its self-update path has no cross-process update lock, so two concurrent self-updates can interfere with the shared updater, installed executable, and proxy links. Its process handoff addresses Windows executable locking, not update serialization or crash-atomic replacement. Dotnetup needs no handoff at all, because renaming an in-use executable does not require one; see the rejected alternative below.

`Aspire CLI` - Aspire's archive self-update [extracts to a temporary directory, best-effort deletes older backups, renames the running executable to `aspire.exe.old.<unix-timestamp>`, copies the extracted executable to the canonical path, runs `aspire.exe --version`, and on any failure deletes the canonical path and moves the backup back](https://github.com/microsoft/aspire/blob/main/src/Aspire.Cli/Commands/UpdateCommand.cs). Dotnetup adopts Aspire's verification-and-rollback shape but uses `File.Replace` for the Windows switch rather than a rename followed by a copy.

Three things differ. Dotnetup stages on the destination volume and uses `File.Replace`, avoiding a cross-volume copy or deliberately split forward moves without promising a gapless canonical path. Dotnetup requires the verification child to report exactly `V_channel`, where Aspire requires only exit status `0` and prints whatever version is returned, so a binary that runs but is the wrong build passes Aspire's check. And Aspire takes no cross-process lock, so concurrent self-updates race over the canonical path and the backups, and nothing stops another Aspire command from running across the replacement — the two problems `U` and `A` exist to solve.

`VS Code` - VS Code's installed Windows updater combines a singleton main process, an [in-process update state machine](https://github.com/microsoft/vscode/blob/main/src/vs/platform/update/electron-main/abstractUpdateService.ts), native application/setup/updating/ready mutexes, staged versioned files, and [Inno Setup](https://github.com/microsoft/vscode/blob/main/build/win32/code.iss). This serializes Windows installers and blocks application startup during the final switch. The statement does not apply uniformly to every distribution: macOS delegates to Electron's updater, while ordinary Linux packages generally delegate installation to the package manager or download page. Dotnetup does not require VS Code's UI state machine or installer framework, but it adopts the narrower invariant that only one self-update transaction may modify its executable at a time.

# Alternatives Considered:

### Content below is not proposed implementation but rather alternatives that we could implement.

Windows also has reboot-delayed renames, but this provides a poor experience for immediate updates as it requires a reboot.

#### Rejected Alternative: `MoveFileExW` from a Separate Replacer Process

An earlier framing called this the "file replace" approach, but the precise operation is a `MoveFileExW` move with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`. Because this operation cannot be relied upon to replace the canonical executable while that destination is running, `P` would copy an updater to a throwaway location, hand the locks to that replacer process `R`, and exit. After incompatible users of `D/dotnetup.exe` drained, `R` would perform the move:

```cs
MoveFileExW(
    stagedPath,
    installedPath,
    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
```

This is a single move of the replacement onto the canonical path, but it does not create the backup; preserving the old executable requires a separate copy, hard link, or rename. `MOVEFILE_WRITE_THROUGH` asks Windows not to return until the move has completed on disk. It improves durability after a successful return, but Microsoft does not document it as an ACID transaction or as an all-or-nothing guarantee across process termination or power loss. Transactional NTFS provided transactional moves, but Microsoft recommends against taking a dependency on TxF because it may not remain available.

The selected `File.Replace` design avoids the temporary process and handoff and creates the backup as part of the same Windows call. It avoids deliberately split forward moves, not all possible canonical-path gaps. It still requires a flushed staged file and explicit handling of `ReplaceFileW`'s documented partial failure states, without promising power-loss atomicity.
