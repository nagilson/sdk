# Motivation

Manipulating the `PATH` environment variable can be tricky when Visual Studio and other installers. These applications are automatically run with updates. They override the system level path on a regular basis which blocks `dotnetup` installs from being used.

To provide an experience during the prototype of `dotnetup` before any official product is changed to work well with `dotnetup`, we propose 'aliasing' or 'shadowing' dotnet commands via `dotnetup` as one option.

One downside to this is that IDE components which processes calling `dotnet` would still be broken by a change to the `PATH`. However, this prevents scripts from being broken.
Another downside is that this requires scripts to be updated to call `dotnetup dotnet` instead of `dotnet`. For many individuals, this is a no-go.
This also adds the overhead of an additional process call.

Yet, until the `dotnet` muxer itself or .NET Installer can be modified, this provides a consistent way for the user to enforce their intended install of `dotnet` when running commands.

This also enables the `PATH` to have the admin install and for the two install types to co-exist to some degree - such that `dotnetup` based installs can still be used by the local user. This also gives `dotnetup` full control over the process call, such that environment variables like `DOTNET_ROOT` can be set.

# Commands

`dotnetup dotnet <>`
`dotnetup do <>`

Arguments in `<>` are forwarded transparently to `dotnet.exe` in the determined location.


# Technical Details

We should avoid allowing an elevated terminal or admin prompt running `dotnetup` from executing a `user` executable.
Therefore, when we spawn `dotnet`, we should revoke privileges by:

We should return with the return value of `dotnet`, whatever that might be.

The spawned process should also set DOTNET_ROOT to the value of the determined `dotnet.exe` location, so that `runtime` based interactions (debug, test, run) can work as expected.

-> dotnet_root_x64 and friends
