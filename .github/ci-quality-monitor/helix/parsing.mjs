import {normalizeEvidenceText, splitNonEmptyLines} from "../evidence-utils.mjs";
import {collectConsoleEvidence} from "./console-evidence.mjs";

export function parseHelixWorkItemReferences(messages)
{
  const pattern = /Work item '([^']+)' in job '(.+) \(([0-9a-f-]{36})\)' failed \([^,]+, exit code (-?\d+)\)\./i;
  return messages.flatMap(message =>
  {
    const match = `${message}`.match(pattern);
    return match ? [{
      workItem: match[1],
      queue: match[2],
      jobId: match[3],
      exitCode: Number.parseInt(match[4], 10)
    }] : [];
  });
}

export function classifyWorkItem(exitCode, consoleText, testFailures = [])
{
  if (testFailures.length > 0)
  {
    return {phase: "test-execution", failureType: "test-assertion", evidenceSources: ["helix-trx"]};
  }
  const text = `${consoleText ?? ""}`;
  if (/test run completed|detected test end tag/i.test(text)
    && /app_crash|timed_out|exit(?:ed)? with (?:80|143)/i.test(text))
  {
    return {
      phase: "test-post-processing",
      failureType: /app_crash/i.test(text) ? "process-crash" : "harness-error",
      evidenceSources: ["helix-console", "process-exit-code"]
    };
  }
  if (/workload timed out|run timed out|timed_out|timeout|timed out/i.test(text)
    || exitCode === 130 || exitCode === 143)
  {
    return {
      phase: "test-execution",
      failureType: "timeout",
      evidenceSources: ["helix-console", "process-exit-code"]
    };
  }
  if (/segmentation fault|stack overflow|core dump(?:ed)?|assert failed|app_crash|created crash dump/i.test(text)
    || [133, 134, 139].includes(exitCode))
  {
    return {
      phase: "test-execution",
      failureType: "process-crash",
      evidenceSources: ["helix-console", "process-exit-code"]
    };
  }
  if ([137, 143, 255].includes(exitCode))
  {
    return {
      phase: "test-execution",
      failureType: "process-termination",
      evidenceSources: ["helix-console", "process-exit-code"]
    };
  }
  if (/device_not_found|infrastructure error|agent connection|machine is not available/i.test(text)
    || [-4, 71, 81].includes(exitCode))
  {
    return {
      phase: "test-execution",
      failureType: "infrastructure-unavailable",
      evidenceSources: ["helix-console", "helix-work-item"]
    };
  }
  return {
    phase: "test-execution",
    failureType: "unknown-error",
    evidenceSources: ["helix-console", "helix-work-item"]
  };
}

export function summarizeHelixConsole(consoleText, evidence = collectConsoleEvidence(consoleText))
{
  const events = evidence.events;
  const activeTests = events.filter(event => event.kind === "active-test");
  const hostExitCode = [...events].reverse().filter(event => event.kind === "process-exit")
    .map(event => event.text.match(/exit code(?: is)?\s*['"]?(-?\d+)/i)?.[1])
    .find(Boolean);
  const hangEvents = events.filter(event => event.kind === "hang-timeout");
  const relevant = events.filter(event => !["diagnostic-context", "operating-system"].includes(event.kind));
  const hangEvidence = [...new Set([
    ...hangEvents.map(event => event.text),
    ...activeTests.map(event => event.text.trim()),
    ...relevant.map(event => event.text)
  ])];
  return {
    activeTest: activeTests.at(-1)?.text.trim() ?? null,
    activeTests: activeTests.map(event => event.text.trim()),
    hangDetected: hangEvents.length > 0,
    hostExitCode: hostExitCode ? Number(hostExitCode) : null,
    operatingSystem: events.findLast(event => event.kind === "operating-system")?.text ?? null,
    hangEvidence: hangEvidence.slice(0, 12),
    omittedHangEvidence: Math.max(0, hangEvidence.length - 12),
    dumpFailures: [...new Set(events.filter(event => event.kind === "dump-failure").map(event => event.text))].slice(-4)
  };
}

export function summarizeTestMechanism(errorMessage, outcome)
{
  const lines = splitNonEmptyLines(errorMessage);
  const salient = lines.filter(line => /exception|error|expected|actual|exit code|status code|timed? ?out|failed/i.test(line));
  return normalizeEvidenceText((salient.length > 0 ? salient : lines).slice(0, 8).join("\n") || `${outcome} test result`);
}

export function summarizeSharedTestMechanism(errorMessage, outcome)
{
  const lines = splitNonEmptyLines(errorMessage);
  const diagnosticLines = lines.filter(line => /\b(?:MSB\d{4}|NETSDK\d{4}|CS\d{4})\b/i.test(line));
  const responseLines = lines.filter(line => /response status code/i.test(line))
    .map(line => line.slice(line.search(/response status code/i)));
  const operationalLines = responseLines.length > 0 ? responseLines
    : lines.filter(line => /service unavailable|timed? ?out|connection|refused|not found|access denied/i.test(line));
  const exceptionLines = lines.filter(line => !/^Test method .+ threw exception:?$/i.test(line))
    .filter(line => /(?:system\.)?\w+exception/i.test(line));
  const rootCauseLines = diagnosticLines.length > 0 ? diagnosticLines
    : operationalLines.length > 0 ? operationalLines
      : exceptionLines;
  const distinctLines = [...new Set(rootCauseLines.length > 0 ? rootCauseLines : lines.slice(-3))];
  return normalizeEvidenceText(distinctLines.slice(0, 4).join("\n") || `${outcome} test result`);
}
