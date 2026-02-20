// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.CommandLine;
using System.Diagnostics;
using Microsoft.DotNet.Tools.Bootstrapper.Telemetry;

namespace Microsoft.DotNet.Tools.Bootstrapper;

internal class DotnetupProgram
{
    public static int Main(string[] args)
    {
        // Handle --debug flag using the standard .NET SDK pattern
        // This is DEBUG-only and removes the --debug flag from args
        DotnetupDebugHelper.HandleDebugSwitch(ref args);

        // Parse once — the ParseResult is used for notice suppression and invocation.
        var parseResult = Parser.Parse(args);

        // --version is a simple machine-readable query — skip telemetry and the
        // first-run notice entirely so scripts get a clean, fast response.
        if (IsVersionRequest(parseResult))
        {
            return Parser.Invoke(parseResult);
        }

        // Show first-run telemetry notice if needed
        FirstRunNotice.ShowIfFirstRun(DotnetupTelemetry.Instance.Enabled, parseResult);

        // Start root activity for the entire process
        using var rootActivity = DotnetupTelemetry.Instance.Enabled
            ? DotnetupTelemetry.CommandSource.StartActivity("dotnetup", ActivityKind.Internal)
            : null;

        try
        {
            var result = Parser.Invoke(parseResult);
            rootActivity?.SetTag("exit.code", result);
            rootActivity?.SetStatus(result == 0 ? ActivityStatusCode.Ok : ActivityStatusCode.Error);
            return result;
        }
        catch (Exception ex)
        {
            // Catch-all for unhandled exceptions
            DotnetupTelemetry.Instance.RecordException(rootActivity, ex);
            rootActivity?.SetTag("exit.code", 1);

            // Log the error and return non-zero exit code
            Console.Error.WriteLine($"Error: {ex.Message}");
#if DEBUG
            Console.Error.WriteLine(ex.StackTrace);
#endif
            return 1;
        }
        finally
        {
            // Ensure telemetry is flushed before exit
            DotnetupTelemetry.Instance.Flush();
            DotnetupTelemetry.Instance.Dispose();
        }
    }

    /// <summary>
    /// Detects whether the parsed command line is a --version request.
    /// System.CommandLine handles --version via a built-in option on the root command.
    /// </summary>
    private static bool IsVersionRequest(ParseResult parseResult)
    {
        // System.CommandLine adds a --version option to RootCommand automatically.
        // When the user passes --version, the root command's VersionOption will be present.
        var versionOption = parseResult.RootCommandResult.Command.Options
            .FirstOrDefault(o => o.Name == "version");
        return versionOption is not null
            && parseResult.GetResult(versionOption) is { Implicit: false };
    }
}
