import {MAX_CONSOLE_CHARACTERS, MAX_TEST_DIAGNOSTIC_CHARACTERS, MAX_TEST_FAILURES} from "../constants.mjs";
import {
  createFailureFamilyFingerprint,
  createFailureFingerprint,
  isAuthenticationFailure,
  isNetworkFailure,
  normalizeEvidenceText
} from "../evidence-utils.mjs";
import {HttpClient} from "../http-client.mjs";
import {createTestKbeCandidate} from "../known-build-error.mjs";
import {parseTestResultXml} from "../test-results.mjs";
import {collectConsoleEvidence, hasHangWatchdog} from "./console-evidence.mjs";
import
{
  classifyWorkItem,
  summarizeHelixConsole,
  summarizeSharedTestMechanism,
  summarizeTestMechanism
} from "./parsing.mjs";

function getUniqueHelixReferences(timelineFailures)
{
  const references = timelineFailures.flatMap(failure => failure.helixReferences ?? []);
  return [...new Map(references.map(reference => [`${reference.jobId}:${reference.workItem}`, reference])).values()];
}

function helixWorkItemUrl(reference)
{
  return `https://helix.dot.net/api/2019-06-17/jobs/${encodeURIComponent(reference.jobId)}/workitems/${encodeURIComponent(reference.workItem)}`;
}

function selectArtifactLinks(files = [])
{
  const candidates = files.filter(file => /\.(?:trx|xml|binlog|dmp|core|crash|log)$/i.test(file.FileName));
  const rank = file => /\.trx$/i.test(file.FileName) ? 0
    : /\.(?:dmp|core|crash)$/i.test(file.FileName) ? 1 : 2;
  const retained = [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, 10);
  return {
    artifacts: retained.map(file => ({name: file.FileName, url: file.Uri})),
    artifactSelection: {
      totalFiles: files.length,
      eligibleFiles: candidates.length,
      retainedFiles: retained.length,
      omittedFiles: candidates.length - retained.length,
      truncated: candidates.length > retained.length
    }
  };
}

export function getArtifactEvidenceSources(files = [])
{
  const sources = [];
  if (files.some(file => /\.(?:trx|xml)$/i.test(file.FileName))) sources.push("helix-trx");
  if (files.some(file => /\.(?:dmp|core|crash)$/i.test(file.FileName))) sources.push("helix-dump");
  return sources;
}

function createTestObservation(reference, test, testSummary, testResultEvidence)
{
  const component = test.fullyQualifiedName || test.testName;
  const mechanism = summarizeTestMechanism(test.errorMessage, test.outcome);
  const sharedMechanism = summarizeSharedTestMechanism(test.errorMessage, test.outcome);
  const phase = "test-execution";
  const failureType = classifyTestFailureType(test.errorMessage, test.outcome);
  const fingerprint = createFailureFingerprint({phase, failureType, component, mechanism});
  return {
    kind: "test",
    phase,
    failureType,
    evidenceSources: ["helix-trx"],
    component,
    mechanism,
    fingerprint,
    failureFamilyFingerprint: hasHangWatchdog(test.errorMessage) ? createFailureFamilyFingerprint({
      phase, failureType, component, mechanism: test.errorMessage
    }) : undefined,
    mechanismFingerprint: createFailureFingerprint({
      phase, failureType, component: "shared", mechanism: sharedMechanism
    }),
    actionable: true,
    workItem: reference.workItem,
    jobId: reference.jobId,
    queue: reference.queue,
    outcome: test.outcome,
    duration: test.duration,
    testSummary,
    testResultEvidence,
    stackTrace: normalizeEvidenceText(test.stackTrace),
    kbe: createTestKbeCandidate(test, fingerprint)
  };
}

function classifyTestFailureType(errorMessage, outcome)
{
  const text = `${errorMessage ?? ""}`;
  if (`${outcome}`.toLowerCase() === "timeout") return "timeout";
  if (`${outcome}`.toLowerCase() === "aborted") return "process-termination";
  if (isAuthenticationFailure(text)) return "authentication-failure";
  if (isNetworkFailure(text)) return "network-failure";
  if (/timed? ?out|timeout/i.test(text)) return "timeout";
  if (/segmentation fault|stack overflow|core dump|app_crash/i.test(text)) return "process-crash";
  if (/\bCS\d{4}\b/i.test(text)) return "compiler-error";
  return "test-assertion";
}

function createWorkItemObservation(reference, workItem, console, testResults, unavailable)
{
  const {classification, consoleSummary, consoleEvidence} = console;
  const causalConsoleLines = consoleSummary.hangEvidence.filter(line => line === consoleSummary.activeTest
    || /still running|hang (?:dump )?timeout|timed? ?out|test host crashed|recovered \d+ test result|exit code/i.test(line));
  const mechanismLines = causalConsoleLines.length > 0
    ? causalConsoleLines
    : consoleEvidence.excerpt.split(/\r?\n/).filter(Boolean).slice(-8);
  const mechanism = normalizeEvidenceText(mechanismLines.join("\n")
    || `Exit code ${workItem.ExitCode ?? reference.exitCode}`);
  const artifactEvidence = selectArtifactLinks(workItem.Files);
  return {
    kind: "helix-work-item",
    ...classification,
    evidenceSources: [...new Set([...classification.evidenceSources, ...getArtifactEvidenceSources(workItem.Files)])],
    component: reference.workItem,
    mechanism,
    fingerprint: createFailureFingerprint({...classification, component: reference.workItem, mechanism}),
    failureFamilyFingerprint: consoleSummary.hangDetected ? createFailureFamilyFingerprint({
      ...classification, component: reference.workItem, mechanism
    }) : undefined,
    actionable: classification.failureType !== "infrastructure-unavailable",
    jobId: reference.jobId,
    queue: reference.queue,
    exitCode: workItem.ExitCode ?? reference.exitCode,
    state: workItem.State,
    machine: workItem.MachineName,
    duration: workItem.Duration,
    testSummary: testResults.summary,
    testResultEvidence: testResults.evidence,
    consoleSummary,
    consoleEvidence,
    consoleUrl: workItem.ConsoleOutputUri,
    ...artifactEvidence,
    unavailable
  };
}

export class HelixEvidenceClient
{
  constructor(fetchImplementation = fetch)
  {
    this.http = new HttpClient(fetchImplementation);
  }

  async getConsoleEvidence(url, exitCode)
  {
    const text = await (await this.http.response(url)).text();
    const consoleEvidence = collectConsoleEvidence(text, MAX_CONSOLE_CHARACTERS);
    const classificationText = consoleEvidence.events.filter(event => [
      "hang-timeout", "timeout", "process-exit", "process-crash", "test-run-completed", "infrastructure-error"
    ].includes(event.kind)).map(event => event.text).join("\n");
    return {
      classification: classifyWorkItem(exitCode, classificationText),
      consoleSummary: summarizeHelixConsole(text, consoleEvidence),
      consoleEvidence
    };
  }

  async getTestResults(workItem)
  {
    const files = workItem.Files ?? [];
    const testFile = files.find(file => /\.trx$/i.test(file.FileName))
      ?? files.find(file => /\.xml$/i.test(file.FileName));
    if (!testFile) return {
      summary: null,
      failures: [],
      evidence: {candidateFiles: 0, retainedFiles: 0, omittedFiles: 0, retainedFailures: 0, truncated: false}
    };
    const response = await this.http.response(testFile.Uri);
    const results = parseTestResultXml(Buffer.from(await response.arrayBuffer()));
    const failures = results.failures.slice(0, MAX_TEST_FAILURES);
    const totalFailures = ["failed", "error", "timeout", "aborted"]
      .reduce((sum, outcome) => sum + (results.summary?.[outcome] ?? 0), 0);
    const candidateFiles = files.filter(file => /\.(?:trx|xml)$/i.test(file.FileName)).length;
    const possiblyTruncatedDiagnostics = failures.filter(test =>
      test.errorMessage?.length === MAX_TEST_DIAGNOSTIC_CHARACTERS
      || test.stackTrace?.length === MAX_TEST_DIAGNOSTIC_CHARACTERS).length;
    return {
      ...results,
      failures,
      evidence: {
        source: {name: testFile.FileName, url: testFile.Uri},
        candidateFiles,
        retainedFiles: 1,
        omittedFiles: candidateFiles - 1,
        totalResults: results.summary?.total ?? null,
        totalFailures,
        retainedFailures: failures.length,
        omittedFailures: Math.max(0, totalFailures - failures.length),
        diagnosticCharacterLimit: MAX_TEST_DIAGNOSTIC_CHARACTERS,
        possiblyTruncatedDiagnostics,
        truncated: totalFailures > failures.length || candidateFiles > 1 || possiblyTruncatedDiagnostics > 0
      }
    };
  }

  async collectWorkItemObservations(reference)
  {
    const url = helixWorkItemUrl(reference);
    const workItem = await this.http.json(url);
    const exitCode = workItem.ExitCode ?? reference.exitCode;
    let console = {
      classification: classifyWorkItem(exitCode, ""),
      consoleSummary: summarizeHelixConsole(""),
      consoleEvidence: collectConsoleEvidence("")
    };
    let testResults = {summary: null, failures: []};
    const unavailable = [];
    try
    {
      console = await this.getConsoleEvidence(`${url}/console`, exitCode);
    } catch (error)
    {
      unavailable.push(normalizeEvidenceText(error.message));
    }
    try
    {
      testResults = await this.getTestResults(workItem);
    } catch (error)
    {
      unavailable.push(normalizeEvidenceText(error.message));
    }
    const testObservations = testResults.failures
      .map(test => ({
        ...createTestObservation(reference, test, testResults.summary, testResults.evidence),
        consoleSummary: console.consoleSummary,
        consoleEvidence: console.consoleEvidence,
        consoleUrl: workItem.ConsoleOutputUri
      }));
    const workItemObservation = createWorkItemObservation(
      reference, workItem, console, testResults, unavailable);
    if (testObservations.length === 0) return [workItemObservation];
    const independentlyClassified = Boolean(workItemObservation.failureFamilyFingerprint)
      || (workItemObservation.failureType !== "unknown-error"
        && !testObservations.some(observation => observation.failureType === workItemObservation.failureType));
    return independentlyClassified ? [...testObservations, workItemObservation] : testObservations;
  }

  async collectObservations(timelineFailures, maxReferences = Number.POSITIVE_INFINITY)
  {
    const observations = [];
    for (const reference of getUniqueHelixReferences(timelineFailures).slice(0, maxReferences))
    {
      try
      {
        observations.push(...await this.collectWorkItemObservations(reference));
      } catch (error)
      {
        observations.push({
          kind: "helix-work-item",
          phase: "test-execution",
          failureType: "evidence-unavailable",
          evidenceSources: ["helix-api"],
          component: reference.workItem,
          mechanism: normalizeEvidenceText(error.message),
          fingerprint: createFailureFingerprint({
            phase: "test-execution",
            failureType: "evidence-unavailable",
            component: reference.workItem,
            mechanism: error.message
          }),
          actionable: false,
          ...reference
        });
      }
    }
    return observations;
  }
}
