import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {shouldRunAgent} from "../collect-ci-evidence.mjs";

test("admission and evidence-only gates override actionable candidates", () =>
{
  const dossier = {bootstrap: false, pipelineHealth: [], failures: [{issueCandidates: [{}]}]};
  assert.equal(shouldRunAgent(dossier), true);
  assert.equal(shouldRunAgent({...dossier, admission: {allowed: false}}), false);
  assert.equal(shouldRunAgent({...dossier, evidenceOnly: true}), false);
});

test("CLI bootstrap persists a closed admission ledger and evidence-only does not mutate it", async () =>
{
  const directory = await mkdtemp(path.join(tmpdir(), "ci-admission-"));
  try
  {
    const registry = path.join(directory, "pipelines.json");
    const output = path.join(directory, "dossier.json");
    const state = path.join(directory, "state.json");
    const githubOutput = path.join(directory, "github-output.txt");
    await writeFile(registry, JSON.stringify({pipelines: []}));
    const command = fileURLToPath(new URL("../collect-ci-evidence.mjs", import.meta.url));
    const args = [command, "--registry", registry, "--output", output, "--state", state,
      "--state-output", state, "--admission-run-id", "12345", "--github-output", githubOutput];
    const first = spawnSync(process.execPath, args, {encoding: "utf8"});
    assert.equal(first.status, 0, first.stderr);
    const before = await readFile(state, "utf8");
    assert.equal(JSON.parse(before).admission.bootstrap, true);
    assert.equal(JSON.parse(await readFile(output, "utf8")).admission.allowed, false);
    const second = spawnSync(process.execPath, [...args, "--evidence-only", "true"], {encoding: "utf8"});
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(state, "utf8"), before);
    assert.equal(JSON.parse(await readFile(output, "utf8")).evidenceOnly, true);
    const projectedText = (await readFile(path.join(directory, "agent-dossier.json"), "utf8")).trim();
    const projected = JSON.parse(projectedText);
    assert.ok(projectedText.length <= 180_000);
    assert.equal(projected.promptEvidence.serializedCharacters, projectedText.length);
    assert.match(await readFile(githubOutput, "utf8"), /should_run=false/);
  }
  finally
  {
    await rm(directory, {recursive: true, force: true});
  }
});
