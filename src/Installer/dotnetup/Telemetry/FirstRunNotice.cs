// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.CommandLine;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.ElevatedAdminPath;
using Microsoft.DotNet.Tools.Bootstrapper.Commands.PrintEnvScript;

namespace Microsoft.DotNet.Tools.Bootstrapper.Telemetry;

/// <summary>
/// Manages the first-run telemetry notice for dotnetup.
/// Displays a brief notice on first use and creates a sentinel file to prevent repeat notices.
/// </summary>
internal static class FirstRunNotice
{
    /// <summary>
    /// Environment variable to suppress the first-run notice (same as .NET SDK).
    /// </summary>
    private const string NoLogoEnvironmentVariable = "DOTNET_NOLOGO";

    /// <summary>
    /// Shows the first-run telemetry notice if this is the first time dotnetup is run
    /// and telemetry is enabled. Creates a sentinel file to prevent future notices.
    /// </summary>
    /// <param name="telemetryEnabled">Whether telemetry is currently enabled.</param>
    /// <param name="parseResult">Parsed command-line result, used to suppress the notice for
    /// machine-readable or non-interactive invocations.</param>
    public static void ShowIfFirstRun(bool telemetryEnabled, ParseResult parseResult)
    {
        // Don't show notice if telemetry is disabled - user has already opted out
        if (!telemetryEnabled)
        {
            return;
        }

        // Respect DOTNET_NOLOGO to suppress notice (same behavior as .NET SDK)
        if (IsNoLogoSet())
        {
            return;
        }

        // Suppress the notice for machine-readable or non-interactive invocations.
        // The notice is intended for interactive terminal users only.
        if (ShouldSuppressNotice(parseResult))
        {
            return;
        }

        var sentinelPath = DotnetupPaths.TelemetrySentinelPath;
        if (string.IsNullOrEmpty(sentinelPath))
        {
            return;
        }

        // Check if we've already shown the notice
        if (File.Exists(sentinelPath))
        {
            return;
        }

        // Show the notice
        ShowNotice();

        // Create the sentinel file to prevent future notices
        CreateSentinel(sentinelPath);
    }

    /// <summary>
    /// Checks if DOTNET_NOLOGO is set to suppress the first-run notice.
    /// </summary>
    private static bool IsNoLogoSet()
    {
        var value = Environment.GetEnvironmentVariable(NoLogoEnvironmentVariable);
        return string.Equals(value, "1", StringComparison.Ordinal) ||
               string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Determines whether the first-run notice should be suppressed based on the
    /// parsed command-line result. The notice is suppressed for:
    /// <list type="bullet">
    ///   <item><c>--format json</c> — machine-readable structured output.</item>
    ///   <item><c>print-env-script</c> — outputs a shell script, not for humans.</item>
    ///   <item><c>elevatedadminpath</c> — internal plumbing command.</item>
    ///   <item>Install/update commands when running in non-interactive mode
    ///         (<c>--interactive</c> not explicitly passed and the default evaluates
    ///         to non-interactive in CI / redirected environments).</item>
    /// </list>
    /// Note: <c>--version</c> is handled earlier in <see cref="DotnetupProgram.Main"/>
    /// which skips both telemetry and the first-run notice entirely.
    /// </summary>
    internal static bool ShouldSuppressNotice(ParseResult parseResult)
    {
        var command = parseResult.CommandResult.Command;

        // Internal / script-emitting commands (compare by Command object identity)
        if (command == PrintEnvScriptCommandParser.GetCommand() ||
            command == ElevatedAdminPathCommandParser.GetCommand())
        {
            return true;
        }

        // Machine-readable JSON output: check if --format is resolved to Json.
        // GetResult returns null if the option wasn't registered on the matched command.
        if (parseResult.GetResult(CommonOptions.FormatOption) is { } formatResult &&
            parseResult.GetValue(CommonOptions.FormatOption) == OutputFormat.Json)
        {
            return true;
        }

        // Install/update commands: suppress when running non-interactively.
        // The --interactive option defaults to false in CI or when stdout is redirected.
        // Only suppress if the user did NOT explicitly pass --interactive.
        if (parseResult.GetResult(CommonOptions.InteractiveOption) is { } interactiveResult)
        {
            bool isInteractive = parseResult.GetValue(CommonOptions.InteractiveOption);
            bool explicitlySet = !interactiveResult.Implicit;

            // Suppress notice only when non-interactive AND the user didn't explicitly request it
            if (!isInteractive && !explicitlySet)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Checks if this is the first run (sentinel doesn't exist).
    /// </summary>
    public static bool IsFirstRun()
    {
        var sentinelPath = DotnetupPaths.TelemetrySentinelPath;
        return !string.IsNullOrEmpty(sentinelPath) && !File.Exists(sentinelPath);
    }

    private static void ShowNotice()
    {
        // Write to stderr, consistent with .NET SDK behavior
        // See: https://learn.microsoft.com/dotnet/core/compatibility/sdk/10.0/dotnet-cli-stderr-output
        Console.Error.WriteLine();
        Console.Error.WriteLine(Strings.TelemetryNotice);
        Console.Error.WriteLine();
    }

    private static void CreateSentinel(string sentinelPath)
    {
        try
        {
            DotnetupPaths.EnsureDataDirectoryExists();

            // Write version info to the sentinel for debugging purposes
            File.WriteAllText(sentinelPath, $"dotnetup telemetry notice shown: {DateTime.UtcNow:O}\nVersion: {BuildInfo.Version}\nCommit: {BuildInfo.CommitSha}\n");
        }
        catch
        {
            // If we can't create the sentinel, the notice will show again next time
            // This is acceptable - better than crashing
        }
    }
}
