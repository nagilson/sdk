import assert from "node:assert/strict";
import test from "node:test";
import {getBuildContext, areIndependentBuilds} from "../build-context.mjs";
import {createBuildSummary} from "../evidence-utils.mjs";
import {AzureDevOpsClient} from "../azure/client.mjs";
import {BuildCandidateSelector} from "../build-candidate-selector.mjs";
import {FailureEvidenceCollector} from "../failure-evidence-collector.mjs";
import {MAX_HISTORY_PAGES, MAX_SELECTED_BUILDS} from "../constants.mjs";

const pipeline = {
  organization: "dnceng-public", project: "public", definitionId: 101, repository: "dotnet/sdk",
  branches: ["refs/heads/main"], stableBranches: ["refs/heads/main"], pullRequestTargets: ["refs/heads/main"]
};

function pr(id, number, target = "main")
{
  return {
    id, reason: "pullRequest", result: "failed", status: "completed",
    sourceBranch: `refs/pull/${number}/merge`, sourceVersion: `commit-${id}`,
    finishTime: "2026-09-05T01:16:56Z", definition: {id: 101}, repository: {id: "dotnet/sdk"},
    triggerInfo: {"pr.number": `${number}`},
    parameters: JSON.stringify({"system.pullRequest.targetBranch": target,
      "system.pullRequest.pullRequestNumber": `${number}`}), validationResults: []
  };
}

test("build-time PR target metadata survives summary without requiring a merge", () =>
{
  const summary = createBuildSummary(pr(42, 123));
  assert.equal(summary.targetBranch, "refs/heads/main");
  assert.equal(summary.pullRequestNumber, 123);
  assert.equal(summary.targetBranchSource, "build.parameters");
  assert.equal("parameters" in summary, false);
  assert.equal(getBuildContext(pr(42, 123, "refs/heads/main")).targetBranch, summary.targetBranch);
});

test("unknown, malformed, conflicting or non-branch targets are not guessed", () =>
{
  const build = pr(42, 123);
  for (const parameters of [undefined, "{", "null", "[]",
    JSON.stringify({"system.pullRequest.targetBranch": "main", "system.pullRequest.targetBranchName": "release/10.0"}),
    JSON.stringify({"system.pullRequest.targetBranch": "refs/pull/1/merge"})])
  {
    const context = getBuildContext({...build, parameters});
    assert.equal(context.targetBranch, null);
    assert.ok(context.unavailable);
  }
  assert.equal(getBuildContext({...build, triggerInfo: {"pr.number": "456"}}).targetBranch, null);
});

test("target history paginates across PR refs, hydrates details and includes direct target builds", async () =>
{
  const builds = [pr(42, 123), pr(41, 124), pr(40, 125, "release/10.0"),
    {...pr(39, 126), reason: "batchedCI", sourceBranch: "refs/heads/main"}];
  const calls = [];
  const client = new AzureDevOpsClient(pipeline, async value =>
  {
    const url = new URL(value);
    calls.push(url);
    if (url.pathname.endsWith("/41")) return Response.json(builds[1]);
    assert.equal(url.searchParams.has("branchName"), false);
    assert.equal(url.searchParams.get("maxTime"), "2026-09-05T01:16:56.000Z");
    assert.equal(url.searchParams.get("minTime"), "2026-08-29T01:16:56.000Z");
    return url.searchParams.has("continuationToken")
      ? Response.json({value: [builds[2], builds[3]]})
      : Response.json({value: [builds[0], {...builds[1], parameters: undefined}]},
        {headers: {"x-ms-continuationtoken": "next"}});
  });
  const result = await client.listTargetBranchHistory("refs/heads/main", builds[0].finishTime);
  assert.deepEqual(result.builds.map(build => build.id), [42, 41, 39]);
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.coverage.truncated, false);
  await client.listTargetBranchHistory("refs/heads/main", builds[0].finishTime);
  assert.equal(calls.length, 3);
});

test("history retrieval is bounded and reports incomplete coverage", async () =>
{
  let calls = 0;
  const client = new AzureDevOpsClient(pipeline, async () =>
    Response.json({value: [pr(++calls, calls)]}, {headers: {"x-ms-continuationtoken": `${calls}`}}));
  const window = await client.listCompletedBuildWindow("2026-09-05T01:16:56Z");
  assert.equal(calls, MAX_HISTORY_PAGES);
  assert.equal(window.coverage.truncated, true);
});

test("open PR event selects a trusted target once and ignores incomplete or unconfigured builds", async () =>
{
  const build = pr(42, 123);
  const state = {schemaVersion: 1, pipelines: {}};
  const azure = {getBuild: async () => build,
    listTargetBranchHistory: async () => ({builds: [build, pr(41, 124)], coverage: {truncated: false}})};
  const selector = new BuildCandidateSelector({pipelines: [pipeline]}, state, () => azure, null);
  const result = await selector.selectEventCandidate("42");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].requiresIndependentRecurrence, true);
  assert.equal(result.candidates[0].targetBranch, "refs/heads/main");
  assert.equal((await selector.selectEventCandidate("42")).candidates.length, 0);
  build.status = "inProgress";
  assert.equal((await selector.selectEventCandidate("42")).candidates.length, 0);
  build.status = "completed";
  build.parameters = "{}";
  assert.equal((await selector.selectEventCandidate("42")).candidates.length, 0);
});

test("same PR and same commit never count as independent recurrence", () =>
{
  const current = createBuildSummary(pr(42, 123));
  assert.equal(areIndependentBuilds(current, createBuildSummary(pr(41, 123))), false);
  assert.equal(areIndependentBuilds(current, {...createBuildSummary(pr(41, 124)), commit: current.commit}), false);
  assert.equal(areIndependentBuilds(current, createBuildSummary(pr(41, 124))), true);
});

test("PR AI candidates require independent matching evidence, not simply another failed build", async () =>
{
  const build = pr(42, 123);
  const observation = {kind: "helix-work-item", phase: "test-execution", failureType: "timeout",
    component: "Example.Tests.dll", fingerprint: "hang", mechanism: "hang", actionable: true};
  const azure = {getTimeline: async () => ({records: [{
    id: "task", type: "Task", name: "Monitor Helix Jobs", result: "failed",
    issues: [{message: "Work item 'Example.Tests.dll' in job 'Linux (123e4567-e89b-12d3-a456-426614174000)' failed (Finished, exit code 7)."}]
  }]}), getTestFailures: async () => []};
  for (const [prior, fingerprint, expected] of [[pr(41, 123), "hang", 0],
    [pr(41, 124), "different", 0], [pr(41, 124), "hang", 1]])
  {
    let calls = 0;
    const collector = new FailureEvidenceCollector(() => azure, {
      collectObservations: async () => [{...observation, fingerprint: calls++ ? fingerprint : "hang"}]
    });
    const result = await collector.collectFailureEvidence(pipeline, build, [build, prior],
      {requiresIndependentRecurrence: true});
    assert.equal(result.issueCandidates.length, expected);
    if (expected) assert.equal(result.issueCandidates[0].recurrence.matchingBuilds[0].pullRequestNumber, 124);
  }
});

test("scheduled PR reconciliation bootstraps and does not mark deferred builds processed", async () =>
{
  const builds = [pr(1, 101)];
  const state = {schemaVersion: 1, pipelines: {}};
  const azure = {listCompletedBuildWindow: async () => ({builds, coverage: {truncated: false}}),
    listCompletedBuilds: async () => []};
  const selector = new BuildCandidateSelector({pipelines: [pipeline]}, state, () => azure,
    {checkPipeline: async () => null});
  assert.equal((await selector.selectScheduledCandidates()).candidates.length, 0);
  builds.unshift(...Array.from({length: MAX_SELECTED_BUILDS + 1}, (_, index) => pr(index + 2, index + 102)));
  assert.equal((await selector.selectScheduledCandidates()).candidates.length, MAX_SELECTED_BUILDS);
  assert.equal((await selector.selectScheduledCandidates()).candidates.length, 1);
  assert.equal((await selector.selectScheduledCandidates()).candidates.length, 0);
});
