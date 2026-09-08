import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONSOLE_CHARACTERS, MAX_LOG_CHARACTERS, MAX_RELATED_MECHANISM_CHARACTERS, MAX_TEST_FAILURES
} from "../constants.mjs";
import {
  createFailureFamilyFingerprint, createFailureFingerprint, normalizeEvidenceText
} from "../evidence-utils.mjs";
import {HelixEvidenceClient} from "../helix/client.mjs";
import {collectConsoleEvidence} from "../helix/console-evidence.mjs";
import {summarizeHelixConsole} from "../helix/parsing.mjs";

const reference = {jobId: "00000000-0000-0000-0000-000000000000", workItem: "new-tests.dll", exitCode: 137};
const failure = {phase: "test-execution", failureType: "timeout", component: reference.workItem};

function rawHang({pid = 35004, os = "Windows", activeTest = "DotnetNew.Tests.CanCreate", path = "/tmp/dumps/20260905"} = {})
{
  return [
    `Operating system: ${os}`,
    "Expected error from a negative template test: error CS1001 Identifier expected.",
    `Process ID: ${pid}Hang dump timeout expired. Capturing process tree.`,
    `${path}Hang dump timeout expired. Capturing hang dumps.`,
    "The following tests were still running when dump was taken:",
    `[50:03] ${activeTest}`,
    "Failed to collect dump for dotnet: Permission denied.",
    "Recovered 2 test results from the crashed host.",
    "Test application process didn't exit gracefully, exit code is '137'."
  ].join("\n");
}

async function collect(consoleText, {files = [], bodies = {}, exitCode = 137, queue = "Windows x64"} = {})
{
  const requests = [];
  const fetchImplementation = async url =>
  {
    requests.push(url);
    if (url.endsWith("/console")) return new Response(consoleText);
    if (url.includes("/workitems/")) return Response.json({
      ExitCode: exitCode, Files: files, ConsoleOutputUri: "https://files.test/console.log"
    });
    assert.ok(Object.hasOwn(bodies, url), `Unexpected request ${url}`);
    return new Response(bodies[url]);
  };
  const observations = await new HelixEvidenceClient(fetchImplementation).collectWorkItemObservations({...reference, queue});
  return {observations, requests};
}

test("raw concatenated PID and temporary path hang markers survive normalization", () =>
{
  for (const raw of [
    "Process ID: 35004Hang dump timeout expired.",
    "/tmp/dumps/20260905Hang dump timeout expired.",
    "C:\\temp\\dumps\\20260906Hang dump timeout expired."
  ])
  {
    assert.match(normalizeEvidenceText(raw), /\nHang dump timeout expired/);
    assert.equal(summarizeHelixConsole(raw).hangDetected, true);
    assert.match(summarizeHelixConsole(raw).hangEvidence[0], /^Hang dump timeout/);
    assert.equal(createFailureFingerprint({...failure, mechanism: raw}), "test-execution|timeout|new-tests.dll|hang-timeout");
  }
});

test("hang family is versioned and invariant to volatile prefixes, OS, active test, and tail", async () =>
{
  const samples = [
    rawHang(),
    rawHang({pid: 99731, os: "Ubuntu", activeTest: "DotnetNew.Tests.CanRestore", path: "/tmp/another/20260908"}),
    rawHang({pid: 4422, os: "macOS", activeTest: "DotnetNew.Tests.CanBuild", path: "C:\\temp\\20261231"})
  ];
  const observations = [];
  for (const [index, raw] of samples.entries())
  {
    const {observations: collected} = await collect(
      `${"unrelated prefix ".repeat(100)}\n${raw}\n${"upload complete\n".repeat(3000 + index)}`,
      {queue: ["Windows x64", "Ubuntu x64", "macOS arm64"][index]});
    observations.push(collected[0]);
  }
  assert.equal(new Set(observations.map(item => item.failureFamilyFingerprint)).size, 1);
  assert.equal(observations[0].failureFamilyFingerprint, "failure-family-v1|test-execution|timeout|new-tests.dll|hang-timeout");
  assert.equal(new Set(observations.map(item => item.fingerprint)).size, 1);
  assert.equal(new Set(observations.map(item => item.consoleSummary.activeTest)).size, 3);
  assert.equal(new Set(observations.map(item => item.consoleSummary.operatingSystem)).size, 3);
  assert.equal(new Set(observations.map(item => item.queue)).size, 3);
  for (const item of observations)
  {
    assert.equal(item.failureType, "timeout");
    assert.equal(item.consoleSummary.hostExitCode, 137);
    assert.match(item.consoleSummary.dumpFailures.join("\n"), /Failed to collect dump/);
    assert.match(item.consoleSummary.hangEvidence.join("\n"), /Recovered 2 test results/);
    assert.ok(item.consoleEvidence.excerpt.length <= MAX_CONSOLE_CHARACTERS);
  }
});

test("hang fingerprints inspect markers beyond the first 180 and 4000 characters", () =>
{
  const mechanism = `${"unrelated output ".repeat(400)}\n/tmp/dumps/20260905Hang dump timeout expired.`;
  assert.equal(createFailureFingerprint({...failure, mechanism}), createFailureFingerprint({
    ...failure, mechanism: "Process ID: 11Hang timeout expired."
  }));
  assert.equal(createFailureFamilyFingerprint({...failure, mechanism}),
    "failure-family-v1|test-execution|timeout|new-tests.dll|hang-timeout");
});

test("different failure kinds and non-hang timeouts do not collapse into the hang family", () =>
{
  const mechanisms = [
    ["process-crash", "Segmentation fault"],
    ["test-assertion", "Expected true but found false"],
    ["authentication-failure", "HTTP response status code 403"],
    ["network-failure", "HTTP response status code 503"],
    ["timeout", "Restore connection timed out"]
  ];
  const fingerprints = mechanisms.map(([failureType, mechanism]) =>
  {
    const observation = {...failure, failureType, mechanism};
    assert.equal(createFailureFamilyFingerprint(observation), undefined);
    return createFailureFingerprint(observation);
  });
  fingerprints.push(createFailureFingerprint({...failure, mechanism: rawHang()}));
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  assert.equal(createFailureFamilyFingerprint({...failure, failureType: "process-crash", mechanism: rawHang()}), undefined);
  assert.notEqual(createFailureFamilyFingerprint({...failure, mechanism: rawHang()}),
    createFailureFamilyFingerprint({...failure, component: "other-tests.dll", mechanism: rawHang()}));
});

test("ordinary fingerprints retain legacy normalization and 180-character segments", () =>
{
  assert.equal(createFailureFingerprint({
    phase: "test-execution", failureType: "network-failure", component: "Tests.Restore",
    mechanism: "Response status code 503 from https://example.test/index.json"
  }), "test-execution|network-failure|tests.restore|response-status-code-<n>-from-<url>");
  assert.equal(createFailureFingerprint({...failure, mechanism: "x".repeat(4000)}),
    `test-execution|timeout|new-tests.dll|${"x".repeat(180)}`);
});

test("full-console selection retains early and middle diagnostics with exact raw provenance", () =>
{
  const raw = `${rawHang()}\n${"ordinary output\n".repeat(2000)}\nActive test: Tests.Late\n${"upload complete\n".repeat(2000)}`;
  const evidence = collectConsoleEvidence(raw);
  assert.equal(evidence.rawTotalCharacters, raw.length);
  assert.equal(evidence.rawTotalBytes, Buffer.byteLength(raw));
  assert.equal(evidence.retainedCharacters, evidence.excerpt.length);
  assert.equal(evidence.retainedRawCharacters + evidence.omittedCharacters, raw.length);
  assert.equal(evidence.retainedBytes + evidence.omittedBytes, Buffer.byteLength(raw));
  assert.equal(evidence.retainedLines + evidence.omittedLines, evidence.rawTotalLines);
  assert.ok(evidence.omittedCharacters > MAX_CONSOLE_CHARACTERS);
  assert.ok(evidence.omittedLines > 0);
  assert.equal(evidence.truncated, true);
  assert.ok(evidence.excerpt.length <= MAX_CONSOLE_CHARACTERS);
  assert.match(evidence.excerpt, /Process ID: 35004Hang dump timeout/);
  assert.match(evidence.excerpt, /\/tmp\/dumps\/20260905Hang dump timeout/);
  assert.match(evidence.excerpt, /Active test: Tests.Late/);
  assert.match(evidence.excerpt, /upload complete/);
  const hang = evidence.events.find(event => event.kind === "hang-timeout");
  assert.equal(hang.line, 3);
  assert.equal(hang.startColumn, "Process ID: 35004".length + 1);
  assert.match(raw.slice(hang.startOffset, hang.endOffset), /^Hang dump timeout/);
  for (const excerpt of evidence.excerpts)
  {
    assert.equal(excerpt.text, raw.slice(excerpt.startOffset, excerpt.endOffset));
    assert.equal(excerpt.startLine, raw.slice(0, excerpt.startOffset).split("\n").length);
    assert.equal(excerpt.endLine, raw.slice(0, excerpt.endOffset - 1).split("\n").length);
  }
});

test("diagnostic context includes negative-test errors without inventing failed assertions", async () =>
{
  const raw = rawHang();
  const {observations} = await collect(raw);
  assert.deepEqual(observations.map(item => item.kind), ["helix-work-item"]);
  const observation = observations[0];
  assert.equal(observation.failureType, "timeout");
  assert.ok(observation.consoleEvidence.events.some(event =>
    event.kind === "diagnostic-context" && event.role === "context-not-assertion"));
  assert.match(observation.consoleEvidence.excerpt, /negative template test: error CS1001/);
  assert.doesNotMatch(observation.mechanism, /CS1001/);
  const negativeOnly = await collect("Expected error CS1001 Identifier expected.\nNegative test passed.", {exitCode: 1});
  assert.equal(negativeOnly.observations[0].failureType, "unknown-error");
  assert.equal(negativeOnly.observations[0].failureFamilyFingerprint, undefined);
});

test("event floods are bounded and report omissions without losing diagnostic kinds", () =>
{
  const raw = `${rawHang()}\n${"Failed to collect dump: permission denied\n".repeat(2000)}${"error CS1001\n".repeat(2000)}`;
  const evidence = collectConsoleEvidence(raw);
  assert.ok(evidence.events.length <= MAX_TEST_FAILURES);
  assert.equal(evidence.totalEvents, evidence.events.length + evidence.omittedEvents);
  assert.ok(evidence.omittedEvents > 0);
  assert.equal(evidence.truncated, true);
  assert.ok(evidence.events.some(event => event.kind === "active-test"));
  assert.ok(evidence.events.some(event => event.kind === "hang-timeout"));
  assert.ok(evidence.events.some(event => event.kind === "diagnostic-context"));
  assert.ok(evidence.excerpt.length <= MAX_CONSOLE_CHARACTERS);
  assert.ok(evidence.events.every(event => event.text.length <= MAX_RELATED_MECHANISM_CHARACTERS));
});

test("long single-line concatenations retain the marker and flag partial ranges and event truncation", () =>
{
  const raw = `${"prefix".repeat(MAX_LOG_CHARACTERS)}Hang dump timeout expired.${"tail".repeat(MAX_CONSOLE_CHARACTERS)}`;
  const evidence = collectConsoleEvidence(raw);
  assert.match(evidence.excerpt, /Hang dump timeout expired/);
  assert.ok(evidence.excerpts.some(range => range.partialStartLine && range.partialEndLine));
  assert.ok(evidence.events.find(event => event.kind === "hang-timeout").truncated);
  assert.ok(evidence.omittedCharacters > 0);
  assert.equal(evidence.omittedLines, 0);
  assert.ok(evidence.excerpt.length <= MAX_CONSOLE_CHARACTERS);
});

test("empty and short consoles have exact size and omission counts", () =>
{
  for (const raw of ["", "normal output", "héllo\r\nworld\r\n", rawHang(), `error CS1001\n${"normal\n".repeat(2000)}`])
  {
    const evidence = collectConsoleEvidence(raw);
    assert.equal(evidence.excerpt, raw);
    assert.equal(evidence.omittedCharacters, 0);
    assert.equal(evidence.omittedBytes, 0);
    assert.equal(evidence.omittedLines, 0);
    assert.equal(evidence.truncated, false);
  }
});

test("partial Unicode windows do not split surrogate pairs or inflate retained byte counts", () =>
{
  const raw = `${"😀".repeat(1000)}Hang timeout expired.\n${"😀".repeat(1000)}`;
  const evidence = collectConsoleEvidence(raw, 257);
  assert.ok(evidence.excerpt.length <= 257);
  assert.ok(evidence.excerpts.every(range => range.text.isWellFormed()));
  assert.equal(evidence.retainedBytes + evidence.omittedBytes, Buffer.byteLength(raw));
  assert.ok(evidence.omittedBytes > 0);
});

test("artifact selection reserves space for TRX and dumps and reports omitted links", async () =>
{
  const logs = Array.from({length: 15}, (_, index) => ({FileName: `log-${index}.log`, Uri: `https://files.test/${index}`}));
  const files = [...logs, {FileName: "hang.dmp", Uri: "https://files.test/dump"}, {FileName: "results.trx", Uri: "https://files.test/trx"}];
  const {observations} = await collect(rawHang(), {
    files, bodies: {"https://files.test/trx": "<TestRun><Results /></TestRun>"}
  });
  const observation = observations[0];
  assert.equal(observation.artifacts.length, 10);
  assert.ok(observation.artifacts.some(file => file.name === "hang.dmp"));
  assert.ok(observation.artifacts.some(file => file.name === "results.trx"));
  assert.equal(observation.artifactSelection.totalFiles, 17);
  assert.equal(observation.artifactSelection.omittedFiles, 7);
  assert.equal(observation.artifactSelection.truncated, true);
});

test("TRX result and file selection limits are visible with retained console context", async () =>
{
  const results = Array.from({length: MAX_TEST_FAILURES + 3}, (_, index) =>
    `<UnitTestResult testId="${index}" testName="Test${index}" outcome="Failed"><Output><ErrorInfo><Message>Expected true</Message></ErrorInfo></Output></UnitTestResult>`).join("");
  const trx = `<TestRun><Results>${results}</Results></TestRun>`;
  const {observations, requests} = await collect("Expected error CS1001 from negative test.\nTests completed.", {
    files: [
      {FileName: "coverage.xml", Uri: "https://files.test/coverage"},
      {FileName: "results.trx", Uri: "https://files.test/trx"},
      {FileName: "other.trx", Uri: "https://files.test/other"}
    ],
    bodies: {"https://files.test/trx": trx},
    exitCode: 1
  });
  assert.equal(observations.length, MAX_TEST_FAILURES);
  assert.equal(requests.filter(url => url.startsWith("https://files.test")).length, 1);
  const evidence = observations[0].testResultEvidence;
  assert.equal(evidence.totalResults, MAX_TEST_FAILURES + 3);
  assert.equal(evidence.totalFailures, MAX_TEST_FAILURES + 3);
  assert.equal(evidence.retainedFailures, MAX_TEST_FAILURES);
  assert.equal(evidence.omittedFailures, 3);
  assert.equal(evidence.omittedFiles, 2);
  assert.equal(evidence.truncated, true);
  assert.match(observations[0].consoleEvidence.excerpt, /negative test/);
});

test("a named TRX timeout does not hide the work-item hang family or assert an active test failed", async () =>
{
  const trx = `<TestRun><Results><UnitTestResult testId="1" testName="SomeTimedOutTest" outcome="Timeout">
    <Output><ErrorInfo><Message>Timed out</Message></ErrorInfo></Output>
    </UnitTestResult></Results></TestRun>`;
  const {observations} = await collect(rawHang(), {
    files: [{FileName: "results.trx", Uri: "https://files.test/trx"}],
    bodies: {"https://files.test/trx": trx}
  });
  assert.deepEqual(observations.map(item => item.kind), ["test", "helix-work-item"]);
  assert.equal(observations[0].component, "SomeTimedOutTest");
  assert.equal(observations[0].failureFamilyFingerprint, undefined);
  assert.equal(observations[1].failureFamilyFingerprint, "failure-family-v1|test-execution|timeout|new-tests.dll|hang-timeout");
  assert.match(observations[1].consoleSummary.activeTest, /DotnetNew.Tests.CanCreate/);
});

test("active-test dump context and timeout exit codes alone do not expose a watchdog family", async () =>
{
  const raw = [
    "The following tests were still running when dump was taken:",
    "[05:00] DotnetNew.Tests.CanCreate",
    "Test application process didn't exit gracefully, exit code is '143'."
  ].join("\n");
  const {observations} = await collect(raw, {exitCode: 143});
  assert.equal(observations[0].failureType, "timeout");
  assert.equal(observations[0].failureFamilyFingerprint, undefined);
  assert.equal(observations[0].consoleSummary.hangDetected, false);
  assert.match(observations[0].consoleSummary.activeTest, /DotnetNew.Tests.CanCreate/);
  assert.ok(observations[0].consoleEvidence.events.some(event => event.kind === "active-test-list"));

  const trx = `<TestRun><Results><UnitTestResult testId="1" testName="TimedOut" outcome="Timeout">
    <Output><ErrorInfo><Message>${raw}</Message></ErrorInfo></Output>
    </UnitTestResult></Results></TestRun>`;
  const named = await collect(raw, {
    exitCode: 143,
    files: [{FileName: "results.trx", Uri: "https://files.test/trx"}],
    bodies: {"https://files.test/trx": trx}
  });
  assert.equal(named.observations[0].kind, "test");
  assert.equal(named.observations[0].failureFamilyFingerprint, undefined);
});

test("timeout command-line configuration is context, not evidence that the watchdog fired", async () =>
{
  const raw = [
    "dotnet exec testhost.dll --blame-hang-timeout 5m",
    "Expected error CS1001 from a negative test.",
    "ordinary output\n".repeat(3000),
    "Segmentation fault (core dumped)"
  ].join("\n");
  const {observations} = await collect(raw, {exitCode: 139});
  assert.equal(observations[0].failureType, "process-crash");
  assert.equal(observations[0].failureFamilyFingerprint, undefined);
  assert.equal(observations[0].consoleSummary.hangDetected, false);
});

test("the fingerprint utility requires an exact watchdog marker, not active-test dump context", () =>
{
  for (const mechanism of [
    "The following tests were still running when dump was taken:",
    "Hang timeoutConfiguration defaults to five minutes.",
    "--blame-hang-timeout 5m",
    "HTTP connection timed out."
  ])
  {
    assert.equal(createFailureFamilyFingerprint({...failure, mechanism}), undefined);
    assert.notEqual(createFailureFingerprint({...failure, mechanism}),
      "test-execution|timeout|new-tests.dll|hang-timeout");
  }
  assert.equal(createFailureFamilyFingerprint({...failure, mechanism: "Process ID: 42Hang timeout expired."}),
    createFailureFamilyFingerprint({...failure, mechanism: "/tmp/20260908Hang dump timeout expired."}));
  assert.equal(normalizeEvidenceText("/tmp/fileHang timeoutConfiguration"),
    "<temporary-path> timeoutConfiguration");
});
