import assert from "node:assert/strict";
import test from "node:test";
import {MAX_RELATED_MECHANISM_CHARACTERS} from "../constants.mjs";
import {MAX_AGENT_DOSSIER_CHARACTERS, prepareAgentDossier} from "../prompt-evidence.mjs";

const family = "failure-family-v1|test-execution|timeout|new-tests.dll|hang-timeout";

function consoleEvidence(raw = "raw console contents")
{
  return {
    schemaVersion: 1,
    selection: "full-console-diagnostic-context-and-tail",
    rawTotalCharacters: raw.length,
    rawTotalBytes: raw.length,
    rawTotalLines: 2,
    retainedCharacters: raw.length,
    retainedRawCharacters: raw.length,
    omittedCharacters: 0,
    omittedLines: 0,
    truncated: false,
    excerpt: raw,
    excerpts: [{startLine: 1, endLine: 2, startOffset: 0, endOffset: raw.length, text: raw}],
    events: [{
      kind: "hang-timeout", role: "diagnostic", line: 1, startOffset: 0, endOffset: 27,
      text: "Hang dump timeout expired.", truncated: false
    }]
  };
}

function observation(index = 0, overrides = {})
{
  return {
    kind: "test",
    phase: "test-execution",
    failureType: "timeout",
    component: `Tests.Test${index}`,
    workItem: "new-tests.dll",
    jobId: "job-1",
    queue: "Windows x64",
    fingerprint: `test-execution|timeout|test${index}|hang-timeout`,
    failureFamilyFingerprint: family,
    mechanismFingerprint: "test-execution|timeout|shared|hang-timeout",
    mechanism: `Hang timeout expired in test ${index}.`,
    actionable: true,
    recurrence: {recurring: true, basis: "failure-family-not-root-cause", matchingBuilds: [{id: 100, pullRequestNumber: 123}]},
    kbe: {
      eligible: true,
      fingerprint: `test-execution|timeout|test${index}|hang-timeout`,
      errorMessage: [`Tests.Test${index}`, "AssertionFailedException", "Hang timeout expired."],
      validation: {valid: true, missing: null},
      buildRetry: false,
      excludeConsoleLog: false
    },
    consoleUrl: "https://files.test/console.log",
    artifacts: [{name: "results.trx", url: "https://files.test/results.trx"}],
    consoleSummary: {
      activeTest: "Tests.ActiveAtWatchdog",
      activeTests: ["Tests.ActiveAtWatchdog"],
      hostExitCode: 137,
      operatingSystem: "Windows",
      hangDetected: true,
      hangEvidence: ["Hang dump timeout expired."],
      dumpFailures: []
    },
    consoleEvidence: consoleEvidence(),
    ...overrides
  };
}

function dossier(candidates = [observation()])
{
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-08T00:00:00Z",
    bootstrap: false,
    evidenceOnly: false,
    admission: {allowed: true, remaining: 1},
    pipelineHealth: [],
    failures: [{
      build: {id: 200, pullRequestNumber: 456, url: "https://builds.test/200"},
      pipeline: {repository: "dotnet/sdk", definitionId: 101},
      priority: "HIGH",
      requiresIndependentRecurrence: true,
      issueCandidates: candidates,
      contextObservations: [],
      relatedFailureSummaries: [],
      recentBuilds: []
    }]
  };
}

function assertWithinBudget(projected, budget = MAX_AGENT_DOSSIER_CHARACTERS)
{
  const json = JSON.stringify(projected);
  assert.ok(json.length <= budget, `${json.length} exceeds ${budget}`);
  assert.equal(projected.promptEvidence.serializedCharacters, json.length);
  assert.equal(projected.promptEvidence.maxCharacters, budget);
  assert.equal(projected.promptEvidence.requiredEvidenceRetained, true);
  assert.deepEqual(JSON.parse(json), projected);
}

test("projection removes raw console copies and preserves provenance, required fields, and the full input", () =>
{
  const full = dossier();
  const original = JSON.stringify(full);
  const projected = prepareAgentDossier(full, {fullEvidenceArtifact: "ci-full-dossier.json"});
  const candidate = projected.failures[0].issueCandidates[0];
  assertWithinBudget(projected);
  assert.equal(JSON.stringify(full), original);
  assert.equal(projected.promptEvidence.fullDossierCharacters, original.length);
  assert.equal(projected.promptEvidence.fullEvidenceArtifact, "ci-full-dossier.json");
  assert.equal(projected.promptEvidence.truncated, true);
  assert.equal("excerpt" in candidate.consoleEvidence, false);
  assert.equal("excerpts" in candidate.consoleEvidence, false);
  assert.deepEqual(candidate.consoleEvidence.lineRanges, [{startLine: 1, endLine: 2, startOffset: 0, endOffset: 20}]);
  assert.equal(candidate.consoleEvidence.events[0].line, 1);
  assert.deepEqual(candidate.consoleSummary, full.failures[0].issueCandidates[0].consoleSummary);
  for (const key of ["fingerprint", "failureFamilyFingerprint", "mechanismFingerprint", "actionable", "kbe", "recurrence", "consoleUrl", "artifacts"])
  {
    assert.deepEqual(candidate[key], full.failures[0].issueCandidates[0][key]);
  }
  assert.ok(projected.promptEvidence.omissions.some(row =>
    row.path.endsWith(".consoleEvidence.excerpt") && row.omittedFields === 1 && row.omittedValueCharacters > 0));
  candidate.kbe.validation.valid = false;
  assert.equal(full.failures[0].issueCandidates[0].kbe.validation.valid, true);
});

test("multiple named tests refer to one current console instead of repeating ranges and events", () =>
{
  const evidence = consoleEvidence("raw diagnostic ".repeat(30_000));
  const full = dossier(Array.from({length: 60}, (_, index) => observation(index, {consoleEvidence: evidence})));
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(full.failures[0].issueCandidates[59].consoleEvidence.excerpt, evidence.excerpt);
  const candidates = projected.failures[0].issueCandidates;
  assert.equal(candidates.length, 60);
  assert.ok(candidates[0].consoleEvidence);
  assert.ok(candidates.slice(1).every(item => !Object.hasOwn(item, "consoleEvidence")
    && item.consoleEvidenceRef === "failures[0].issueCandidates[0].consoleEvidence"));
  assert.ok(projected.promptEvidence.omissions.some(row =>
    row.reason === "duplicate-console-reference" && row.omittedFields === 59));
  assert.equal(projected.promptEvidence.coverage.issueCandidates.retained, 60);
  assert.equal(projected.promptEvidence.coverage.issueCandidates.omitted, 0);
  assert.doesNotMatch(JSON.stringify(projected), /raw diagnostic raw diagnostic/);
});

test("large multi-observation prompts keep current and matching related evidence ahead of unrelated context", () =>
{
  const full = dossier(Array.from({length: 60}, (_, index) => observation(index, {
    mechanism: `Hang timeout expired. ${"details ".repeat(400)}`,
    stackTrace: "stack frame\n".repeat(400)
  })));
  const failure = full.failures[0];
  failure.recentBuilds = Array.from({length: 50}, (_, id) => ({id, noise: "history ".repeat(1000)}));
  failure.contextObservations = [observation(100, {actionable: false, additionalContext: "noise".repeat(30_000)})];
  failure.relatedFailureSummaries = [{
    build: {id: 100, pullRequestNumber: 123, url: "https://builds.test/100"},
    observations: [
      observation(900, {
        actionable: false, failureType: "network-failure", failureFamilyFingerprint: "different", mechanismFingerprint: "different",
        noise: "unmatched context ".repeat(20_000)
      }),
      observation(901, {jobId: "job-2", queue: "Ubuntu x64", consoleSummary: {activeTest: "Tests.Different", operatingSystem: "Ubuntu"}})
    ],
    taskFailures: [{name: "Unrelated task", issues: ["task context ".repeat(50_000)]}]
  }];
  const original = JSON.stringify(full);
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(JSON.stringify(full), original);
  assert.equal(projected.failures[0].issueCandidates.length, 60);
  assert.equal(projected.failures[0].relatedFailureSummaries[0].observations.length, 1);
  assert.equal(projected.failures[0].relatedFailureSummaries[0].observations[0].component, "Tests.Test901");
  assert.equal(projected.failures[0].relatedFailureSummaries[0].observations[0].queue, "Ubuntu x64");
  assert.equal(projected.promptEvidence.coverage.matchingRelatedObservations.total, 1);
  assert.equal(projected.promptEvidence.coverage.matchingRelatedObservations.retained, 1);
  assert.equal(projected.promptEvidence.coverage.relatedObservations.omitted, 1);
  assert.equal(projected.promptEvidence.coverage.contextObservations.omitted, 1);
  assert.ok(projected.promptEvidence.omissions.some(row => row.reason === "unmatched-related-context-budget"));
  for (const [index, candidate] of projected.failures[0].issueCandidates.entries())
  {
    assert.equal(candidate.mechanism.length, MAX_RELATED_MECHANISM_CHARACTERS);
    assert.deepEqual(candidate.kbe, full.failures[0].issueCandidates[index].kbe);
    assert.deepEqual(candidate.recurrence, full.failures[0].issueCandidates[index].recurrence);
  }
});

test("budget covers JSON escaping and projection metadata and serialization is deterministic", () =>
{
  const full = dossier(Array.from({length: 10}, (_, index) => observation(index, {
    mechanism: `Hang timeout expired.\n${"\u0000\"\\😀".repeat(400)}`
  })));
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(JSON.stringify(projected), JSON.stringify(prepareAgentDossier(full)));
  assert.ok(projected.promptEvidence.omissions.some(row => row.reason === "diagnostic-character-limit"));
  for (const candidate of projected.failures[0].issueCandidates)
  {
    assert.ok(candidate.mechanism.isWellFormed());
    assert.ok(candidate.mechanism.length <= MAX_RELATED_MECHANISM_CHARACTERS);
  }
});

test("empty evidence remains a valid non-actionable dossier with exact coverage", () =>
{
  const full = {...dossier([]), failures: []};
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(projected.promptEvidence.truncated, false);
  assert.deepEqual(projected.promptEvidence.omissions, []);
  assert.deepEqual(projected.promptEvidence.coverage.issueCandidates, {total: 0, retained: 0, omitted: 0});
});

test("oversized irreducible KBE patterns fail explicitly without changing eligibility or truncating patterns", () =>
{
  const full = dossier([observation(0, {kbe: {
    eligible: true, validation: {valid: true}, errorMessage: ["required ".repeat(25_000)]
  }})]);
  const original = JSON.stringify(full);
  assert.throws(() => prepareAgentDossier(full), error =>
  {
    assert.equal(error.code, "AGENT_DOSSIER_BUDGET_EXCEEDED");
    assert.equal(error.maxCharacters, MAX_AGENT_DOSSIER_CHARACTERS);
    assert.ok(error.requiredCharacters > error.maxCharacters);
    assert.match(error.message, /Do not activate the agent/);
    return true;
  });
  assert.equal(JSON.stringify(full), original);
  assert.equal(full.failures[0].issueCandidates[0].kbe.eligible, true);
});

test("required matching related evidence is not discarded to make an oversized prompt appear complete", () =>
{
  const full = dossier();
  full.failures[0].relatedFailureSummaries = [{
    build: {id: 100},
    observations: [observation(2, {requiredDiagnostic: "x".repeat(MAX_AGENT_DOSSIER_CHARACTERS)})]
  }];
  assert.throws(() => prepareAgentDossier(full), {code: "AGENT_DOSSIER_BUDGET_EXCEEDED"});
});

test("actionable related identities are protected even without a match to the current candidate", () =>
{
  const full = dossier();
  full.failures[0].relatedFailureSummaries = [{
    build: {id: 100},
    observations: [observation(2, {
      failureType: "process-crash", fingerprint: "test-execution|process-crash|previous-test|crash",
      failureFamilyFingerprint: null, mechanismFingerprint: "different",
      requiredDiagnostic: "x".repeat(MAX_AGENT_DOSSIER_CHARACTERS)
    })]
  }];
  assert.throws(() => prepareAgentDossier(full), {code: "AGENT_DOSSIER_BUDGET_EXCEEDED"});
});

test("matching related summaries project raw consoles but retain collection metadata and source identities", () =>
{
  const full = dossier();
  const previous = observation(2, {
    consoleEvidence: consoleEvidence("related raw console ".repeat(20_000)),
    artifactSelection: {totalFiles: 20, retainedFiles: 10, omittedFiles: 10, truncated: true},
    testResultEvidence: {sourceUrl: "https://files.test/prior.trx", totalFailures: 24, retainedFailures: 20, omittedFailures: 4}
  });
  full.failures[0].relatedFailureSummaries = [{build: {id: 100, pullRequestNumber: 123}, observations: [previous]}];
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  const related = projected.failures[0].relatedFailureSummaries[0];
  assert.deepEqual(related.build, full.failures[0].relatedFailureSummaries[0].build);
  for (const key of ["jobId", "workItem", "queue", "fingerprint", "failureFamilyFingerprint",
    "mechanismFingerprint", "consoleUrl", "consoleSummary", "artifacts", "artifactSelection", "testResultEvidence"])
  {
    assert.deepEqual(related.observations[0][key], previous[key]);
  }
  assert.doesNotMatch(JSON.stringify(projected), /related raw console related raw console/);
  assert.equal("excerpt" in related.observations[0].consoleEvidence, false);
  assert.equal("excerpts" in related.observations[0].consoleEvidence, false);
  assert.equal(projected.promptEvidence.coverage.matchingRelatedObservations.retained, 1);
  assert.equal(full.failures[0].relatedFailureSummaries[0].observations[0].consoleEvidence.excerpt.length, 400_000);
});

test("unknown required fields cannot escape the whole-dossier budget", () =>
{
  const full = dossier();
  full.failures[0].build.requiredMetadata = "x".repeat(MAX_AGENT_DOSSIER_CHARACTERS);
  assert.throws(() => prepareAgentDossier(full), {code: "AGENT_DOSSIER_BUDGET_EXCEEDED"});
});

test("actionable health remains protected while nonactionable health is removable context", () =>
{
  const full = dossier([]);
  full.pipelineHealth = [
    {kind: "pipeline-heartbeat", actionable: false, mechanism: "network outage", noise: "x".repeat(200_000)},
    {kind: "pipeline-heartbeat", actionable: true, fingerprint: "pipeline|stalled", mechanism: "No builds"}
  ];
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(projected.pipelineHealth.length, 1);
  assert.equal(projected.pipelineHealth[0].actionable, true);
  assert.deepEqual(projected.promptEvidence.coverage.actionablePipelineHealth, {total: 1, retained: 1, omitted: 0});
  assert.equal(projected.promptEvidence.coverage.pipelineHealth.omitted, 1);
});

test("a missing fingerprint is not evidence that unrelated observations match", () =>
{
  const full = dossier([{kind: "pipeline", phase: "build", failureType: "unknown-error", actionable: true, mechanism: "current"}]);
  full.failures[0].relatedFailureSummaries = [{
    build: {id: 100},
    observations: [{kind: "pipeline", phase: "build", failureType: "unknown-error", mechanism: "other", noise: "x".repeat(200_000)}]
  }];
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(projected.failures[0].relatedFailureSummaries[0].observations.length, 0);
  assert.equal(projected.promptEvidence.coverage.matchingRelatedObservations.total, 0);
});

test("custom budgets cannot exceed the hard cap and still include the coverage report", () =>
{
  for (const maxCharacters of [0, -1, 1.5, Number.POSITIVE_INFINITY, MAX_AGENT_DOSSIER_CHARACTERS + 1])
  {
    assert.throws(() => prepareAgentDossier(dossier(), {maxCharacters}), RangeError);
  }
  assertWithinBudget(prepareAgentDossier(dossier(), {maxCharacters: 6000}), 6000);
  assert.throws(() => prepareAgentDossier(dossier(), {maxCharacters: 1}), {code: "AGENT_DOSSIER_BUDGET_EXCEEDED"});
});

test("the cap applies across multiple failures with distinct large consoles, not independently per observation", () =>
{
  const full = dossier([]);
  full.failures = Array.from({length: 3}, (_, build) =>
  {
    const failure = dossier(Array.from({length: 15}, (_, index) =>
    {
      const evidence = consoleEvidence();
      evidence.events = Array.from({length: 20}, (_, event) => ({
        kind: "hang-timeout", line: event + 1, text: "Hang timeout expired. " + "detail ".repeat(130)
      }));
      return observation(build * 15 + index, {jobId: `job-${build}-${index}`, consoleEvidence: evidence});
    })).failures[0];
    failure.build.id = build;
    return failure;
  });
  const projected = prepareAgentDossier(full);
  assertWithinBudget(projected);
  assert.equal(projected.failures.length, 3);
  assert.ok(projected.failures.every(failure => failure.issueCandidates.length === 15));
  assert.deepEqual(projected.promptEvidence.coverage.issueCandidates, {total: 45, retained: 45, omitted: 0});
  assert.ok(projected.promptEvidence.omissions.some(row =>
    row.path.endsWith(".consoleEvidence.events") && row.reason === "optional-diagnostic-budget" && row.omittedItems > 0));
  for (const failure of projected.failures)
  {
    for (const candidate of failure.issueCandidates)
    {
      assert.equal(candidate.kbe.eligible, true);
      assert.equal(candidate.consoleUrl, "https://files.test/console.log");
      assert.equal(candidate.consoleSummary.activeTest, "Tests.ActiveAtWatchdog");
    }
  }
});
