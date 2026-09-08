import assert from "node:assert/strict";
import test from "node:test";
import checkpoint from "../checkpoint.cjs";

const context = {repo: {owner: "dotnet", repo: "sdk"}, ref: "refs/heads/main", runId: 100};
function artifact(id, day, branch = "main")
{
  return {created_at: `2026-09-${day}T12:00:00Z`, expired: false,
    workflow_run: {id, head_branch: branch}};
}

test("restore chooses newest artifact for this workflow and branch, never a stale cache", async () =>
{
  const github = {rest: {actions: {
    getWorkflowRun: async ({run_id}) => ({data: {workflow_id: run_id === 90 ? 999 : 123}}),
    listArtifactsForRepo: async () => ({data: {artifacts: [
      artifact(10, "01"), artifact(80, "08"), artifact(90, "09"), artifact(91, "10", "other"),
      {...artifact(92, "11"), expired: true}, artifact(100, "12")
    ]}})
  }}};
  assert.equal(await checkpoint.findStateCheckpoint({github, context}), 80);
});

test("checkpoint discovery fails closed on service errors or a truncated search", async () =>
{
  const github = {rest: {actions: {
    getWorkflowRun: async () => ({data: {workflow_id: 123}}),
    listArtifactsForRepo: async () => {throw new Error("permission denied");}
  }}};
  await assert.rejects(checkpoint.findStateCheckpoint({github, context}), /permission denied/);
  let pages = 0;
  github.rest.actions.listArtifactsForRepo = async () =>
  {
    pages++;
    return {data: {artifacts: Array.from({length: 100}, () => artifact(10, "01", "other"))}};
  };
  await assert.rejects(checkpoint.findStateCheckpoint({github, context}), /search limit/);
  assert.equal(pages, 5);
});

test("no checkpoints is an explicit bootstrap result", async () =>
{
  const github = {rest: {actions: {
    getWorkflowRun: async () => ({data: {workflow_id: 123}}),
    listArtifactsForRepo: async () => ({data: {artifacts: []}})
  }}};
  assert.equal(await checkpoint.findStateCheckpoint({github, context}), null);
});
