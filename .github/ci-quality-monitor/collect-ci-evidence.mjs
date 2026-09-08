import {appendFile, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";
import {collectCiEvidence} from "./collector.mjs";
import {getRecentlyTrackedFingerprints, suppressTrackedIssueCandidates} from "./issue-deduplication.mjs";
import {initializeAdmission, reserveAdmission} from "./admission.mjs";
import {prepareAgentDossier} from "./prompt-evidence.mjs";

export
{
    classifyTaskFailure,
    createPipelineObservation,
    createTaskObservations
} from "./azure/observations.mjs";
export
{
    applyKbeRecurrence,
    createHeartbeatObservation,
    getTimelineFailuresFromRecords
} from "./collector-policy.mjs";
export
{
    CiEvidenceCollector, collectCiEvidence
} from "./collector.mjs";
export
{
    createBuildAttemptKey,
    createBuildSummary,
    createFailureFingerprint,
    createFingerprintSegment,
    normalizeEvidenceText
} from "./evidence-utils.mjs";
export {getArtifactEvidenceSources} from "./helix/client.mjs";
export
{
    classifyWorkItem,
    parseHelixWorkItemReferences,
    summarizeHelixConsole,
    summarizeSharedTestMechanism
} from "./helix/parsing.mjs";
export {getRecentlyTrackedFingerprints, suppressTrackedIssueCandidates} from "./issue-deduplication.mjs";
export {selectUnprocessedFailures} from "./state.mjs";
export {parseTestResultXml} from "./test-results.mjs";

export function parseArguments(argumentsList)
{
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 2)
    {
        const key = argumentsList[index];
        if (!key?.startsWith("--") || index + 1 >= argumentsList.length)
        {
            throw new Error(`Invalid argument near '${key ?? "end of arguments"}'.`);
        }
        options[key.slice(2)] = argumentsList[index + 1];
    }
    if (!options.registry || !options.output)
    {
        throw new Error("--registry and --output are required.");
    }
    return options;
}

async function readState(statePath)
{
    if (!statePath) return {schemaVersion: 1, pipelines: {}};
    try
    {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (state.schemaVersion !== 1 || typeof state.pipelines !== "object")
        {
            throw new Error("Unsupported CI quality monitor state format.");
        }
        return state;
    } catch (error)
    {
        if (error.code === "ENOENT") return {schemaVersion: 1, pipelines: {}};
        throw error;
    }
}

export function shouldRunAgent(dossier)
{
    if (dossier.bootstrap || dossier.evidenceOnly || (dossier.admission && !dossier.admission.allowed)) return false;
    const actionableHealth = dossier.pipelineHealth.filter(observation => observation.actionable).length;
    const issueCandidates = dossier.failures.reduce(
        (count, failure) => count + (failure.issueCandidates?.length ?? 0), 0);
    return issueCandidates + actionableHealth > 0;
}

async function writeGitHubOutputs(outputPath, dossier, fullEvidencePath)
{
    if (!outputPath) return;
    const delimiter = `CI_QUALITY_${Date.now()}`;
    const projected = prepareAgentDossier(dossier, {fullEvidenceArtifact: "ci-quality-evidence/dossier.json"});
    const compactDossier = JSON.stringify(projected);
    await writeFile(path.join(path.dirname(fullEvidencePath), "agent-dossier.json"), `${compactDossier}\n`);
    const actionableHealth = dossier.pipelineHealth.filter(observation => observation.actionable).length;
    await appendFile(outputPath, `should_run=${shouldRunAgent(dossier)}\n`);
    await appendFile(outputPath, `failure_count=${dossier.failures.length + actionableHealth}\n`);
    await appendFile(outputPath, `dossier<<${delimiter}\n${compactDossier}\n${delimiter}\n`);
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const registry = JSON.parse(await readFile(options.registry, "utf8"));
    let state = await readState(options.state);
    const evidenceOnly = options["evidence-only"] === "true";
    if (Object.hasOwn(options, "evidence-only") && !["true", "false"].includes(options["evidence-only"]))
    {
        throw new Error("--evidence-only must be true or false.");
    }
    let admission;
    if (Object.hasOwn(options, "admission-run-id") && !evidenceOnly)
    {
        if (!options.state || !options["state-output"]) throw new Error("Admission requires durable input and output state.");
        const now = new Date();
        if (!Object.hasOwn(state, "admission")) state = initializeAdmission(state, {now}).state;
        admission = reserveAdmission(state, {runId: options["admission-run-id"], now});
        if (!admission.allowed) state = admission.state;
    }
    const dossier = admission && !admission.allowed
        ? {schemaVersion: 1, generatedAt: new Date().toISOString(), bootstrap: false,
            pipelineHealth: [], failures: []}
        : await collectCiEvidence(
        registry,
        options["build-id"],
        state,
        fetch,
        options["event-build-id"],
        options["event-head-sha"],
        options["merged-pr-number"] ? {
            number: Number(options["merged-pr-number"]),
            baseRef: options["merged-pr-base-ref"],
            mergeCommitSha: options["merged-pr-commit-sha"]
        } : null);
    const trackedFingerprints = await getRecentlyTrackedFingerprints(
        options["github-repository"], options["github-token"]);
    suppressTrackedIssueCandidates(dossier, trackedFingerprints);
    if (admission)
    {
        if (admission.allowed && shouldRunAgent(dossier)) state.admission = admission.state.admission;
        dossier.admission = {allowed: admission.allowed, reason: admission.reason, remaining: admission.remaining};
    }
    dossier.evidenceOnly = evidenceOnly;
    await mkdir(path.dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(dossier, null, 2)}\n`);
    if (options["state-output"] && !evidenceOnly)
    {
        await mkdir(path.dirname(options["state-output"]), {recursive: true});
        await writeFile(options["state-output"], `${JSON.stringify(state, null, 2)}\n`);
    }
    await writeGitHubOutputs(options["github-output"], dossier, options.output);
    console.log(`Collected ${dossier.failures.length} failed build dossier(s) in ${options.output}.`);
    for (const note of dossier.selectionNotes ?? []) console.log(note);
    console.log(`Agent activation: ${shouldRunAgent(dossier)}; ${evidenceOnly ? "evidence-only"
        : admission?.reason ?? "local collection"}; actionable observations: ${
        dossier.failures.reduce((count, failure) => count + failure.issueCandidates.length, 0)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
{
    main().catch(error =>
    {
        console.error(error.stack ?? error.message);
        process.exitCode = 1;
    });
}
