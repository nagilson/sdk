import
{
  isPullRequestBuild,
  isRegisteredBuild,
  isStableBranchBuild,
  matchesPipeline
} from "./collector-policy.mjs";
import {createBuildAttemptKey, isFailedBuild} from "./evidence-utils.mjs";
import {getBuildContext} from "./build-context.mjs";
import {MAX_SELECTED_BUILDS} from "./constants.mjs";
import
{
  createAuditKey,
  createPipelineStateKey,
  isAuditProcessed,
  markAuditProcessed,
  recordProcessedBuilds,
  selectUnprocessedFailures
} from "./state.mjs";

/** @typedef {import("./types.d.ts").CandidateSelection} CandidateSelection */

function emptySelection(reason)
{
  return {candidates: [], bootstrap: false, pipelineHealth: [], selectionNotes: reason ? [reason] : []};
}

export class BuildCandidateSelector
{
  constructor(registry, state, getAzureClient, pipelineHealthMonitor)
  {
    this.registry = registry;
    this.state = state;
    this.getAzureClient = getAzureClient;
    this.pipelineHealthMonitor = pipelineHealthMonitor;
  }

  async selectManualBuild(buildId)
  {
    for (const pipeline of this.registry.pipelines)
    {
      try
      {
        const build = await this.getAzureClient(pipeline).getBuild(buildId);
        if (matchesPipeline(build, pipeline)) return {pipeline, build};
      } catch (error)
      {
        if (error.status !== 404) throw error;
      }
    }
    throw new Error(`Build ${buildId} is not from a pipeline and repository in the registry.`);
  }

  selectHighCandidate(pipeline, build, history, auditContext, mergedPullRequest = null)
  {
    const auditKey = createAuditKey(build, "stable-branch", auditContext);
    const candidate = !isAuditProcessed(this.state, pipeline, auditKey) && isFailedBuild(build) ? build : null;
    markAuditProcessed(this.state, pipeline, auditKey);
    return {
      candidates: candidate ? [{
        pipeline, build: candidate, history, monitoringScope: "stable-branch", priority: "HIGH",
        auditContext, mergedPullRequest
      }] : [],
      bootstrap: false,
      pipelineHealth: []
    };
  }

  async getHistory(pipeline, build)
  {
    const azure = this.getAzureClient(pipeline);
    const {targetBranch} = getBuildContext(build);
    if ((pipeline.pullRequestTargets ?? []).includes(targetBranch))
    {
      const window = await azure.listTargetBranchHistory(targetBranch, build.finishTime);
      return {history: window.builds, historyCoverage: window.coverage, targetBranch};
    }
    return {history: await azure.listCompletedBuilds(build.sourceBranch), targetBranch};
  }

  async selectPullRequestCandidate(pipeline, build, window = null)
  {
    const {targetBranch} = getBuildContext(build);
    if (!isPullRequestBuild(build, pipeline)
      || !(pipeline.stableBranches ?? []).includes(targetBranch)
      || !(pipeline.pullRequestTargets ?? []).includes(targetBranch))
    {
      return emptySelection(`Build ${build.id}: ${getBuildContext(build).unavailable
        ?? `PR target ${targetBranch ?? "unknown"} is not enabled`}.`);
    }
    const auditContext = `pr-target:${targetBranch}`;
    const auditKey = createAuditKey(build, "pull-request", auditContext);
    if (!isFailedBuild(build) || isAuditProcessed(this.state, pipeline, auditKey)) return emptySelection();
    const history = window
      ? {history: window.builds.filter(candidate => getBuildContext(candidate).targetBranch === targetBranch),
        historyCoverage: window.coverage, targetBranch}
      : await this.getHistory(pipeline, build);
    markAuditProcessed(this.state, pipeline, auditKey);
    return {candidates: [{pipeline, build, ...history, monitoringScope: "pull-request",
      auditContext, requiresIndependentRecurrence: true}], bootstrap: false, pipelineHealth: []};
  }

  async selectEventCandidate(buildId, mergedPullRequest = null)
  {
    const selected = await this.selectManualBuild(buildId);
    if (selected.build.status && selected.build.status.toLowerCase() !== "completed") return emptySelection();
    if (isStableBranchBuild(selected.build, selected.pipeline))
    {
      const context = await this.getHistory(selected.pipeline, selected.build);
      const result = this.selectHighCandidate(
        selected.pipeline, selected.build, context.history, `stable-direct:${selected.build.sourceBranch}`);
      result.candidates.forEach(candidate => Object.assign(candidate, context));
      return result;
    }
    if (!mergedPullRequest) return this.selectPullRequestCandidate(selected.pipeline, selected.build);
    if (!mergedPullRequest?.number || !mergedPullRequest.baseRef || !mergedPullRequest.mergeCommitSha
      || !isPullRequestBuild(selected.build, selected.pipeline)) return emptySelection();
    const stableTarget = `refs/heads/${mergedPullRequest.baseRef}`;
    if (!(selected.pipeline.stableBranches ?? []).includes(stableTarget)
      || getBuildContext(selected.build).targetBranch !== stableTarget
      || `${selected.build.triggerInfo?.["pr.number"]}` !== `${mergedPullRequest.number}`)
    {
      return emptySelection();
    }
    const context = await this.getHistory(selected.pipeline, selected.build);
    return this.selectHighCandidate(
      selected.pipeline, selected.build, context.history,
      `stable-merge:${mergedPullRequest.number}:${mergedPullRequest.mergeCommitSha}`, mergedPullRequest);
  }

  async selectEventCandidateByHead(headSha, mergedPullRequest = null)
  {
    for (const pipeline of this.registry.pipelines)
    {
      const build = await this.getAzureClient(pipeline).findPullRequestBuildByHead(
        headSha, mergedPullRequest?.number);
      if (build) return this.selectEventCandidate(`${build.id}`, mergedPullRequest);
    }
    return emptySelection();
  }

  /** @returns {Promise<CandidateSelection>} */
  async selectCandidates(buildId, eventBuildId, eventHeadSha, mergedPullRequest)
  {
    if (buildId)
    {
      const selected = await this.selectManualBuild(buildId);
      if (selected.build.status?.toLowerCase() !== "completed") return emptySelection();
      const history = await this.getHistory(selected.pipeline, selected.build);
      return {candidates: [{...selected, ...history,
        requiresIndependentRecurrence: isPullRequestBuild(selected.build, selected.pipeline)}],
        bootstrap: false, pipelineHealth: []};
    }
    if (eventBuildId) return this.selectEventCandidate(eventBuildId, mergedPullRequest);
    if (eventHeadSha) return this.selectEventCandidateByHead(eventHeadSha, mergedPullRequest);
    return this.selectScheduledCandidates();
  }

  /** @returns {Promise<CandidateSelection>} */
  async selectScheduledCandidates()
  {
    const candidates = [];
    const pipelineHealth = [];
    let branchCount = 0;
    let bootstrappedBranchCount = 0;
    for (const pipeline of this.registry.pipelines)
    {
      if ((pipeline.pullRequestTargets ?? []).length > 0)
      {
        const window = await this.getAzureClient(pipeline).listCompletedBuildWindow();
        const key = createPipelineStateKey(pipeline, "pull-request-targets");
        const initialized = Boolean(this.state.pipelines[key]);
        // A new reconciliation scope establishes a baseline without replaying old PRs.
        if (initialized)
        {
          for (const build of window.builds.filter(build => isPullRequestBuild(build, pipeline) && isFailedBuild(build)))
          {
            if (candidates.length >= MAX_SELECTED_BUILDS) break;
            if (build.finishTime <= this.state.pipelines[key].baselineThrough) continue;
            if ((this.state.pipelines[key].processedBuildKeys ?? []).includes(
              createBuildAttemptKey(build))) continue;
            const selection = await this.selectPullRequestCandidate(pipeline, build, window);
            candidates.push(...selection.candidates);
          }
        }
        else
        {
          recordProcessedBuilds(this.state, key, window.builds);
          this.state.pipelines[key].baselineThrough = window.coverage.through;
        }
      }
      for (const branch of pipeline.branches)
      {
        branchCount++;
        const azure = this.getAzureClient(pipeline);
        const history = (await azure.listCompletedBuilds(branch)).filter(build => isRegisteredBuild(build, pipeline));
        const key = createPipelineStateKey(pipeline, branch);
        const selected = selectUnprocessedFailures(this.state, key, history);
        if (selected.bootstrap) bootstrappedBranchCount++;
        for (const build of selected.bootstrap ? [] : selected.failures)
        {
          if (candidates.length >= MAX_SELECTED_BUILDS) break;
          if ((pipeline.stableBranches ?? []).includes(branch))
          {
            const auditContext = `stable-direct:${branch}`;
            const auditKey = createAuditKey(build, "stable-branch", auditContext);
            if (!isAuditProcessed(this.state, pipeline, auditKey))
            {
              markAuditProcessed(this.state, pipeline, auditKey);
              candidates.push({
                pipeline, build, history, monitoringScope: "stable-branch", priority: "HIGH", auditContext
              });
            }
          }
        }
        const healthObservation = await this.pipelineHealthMonitor.checkPipeline(pipeline, branch, azure, key);
        if (healthObservation) pipelineHealth.push(healthObservation);
        const delivered = new Set(candidates.map(candidate => candidate.build.id));
        recordProcessedBuilds(this.state, key, selected.bootstrap ? history
          : history.filter(build => !isFailedBuild(build) || delivered.has(build.id)
            || isAuditProcessed(this.state, pipeline, createAuditKey(build, "stable-branch", `stable-direct:${branch}`))));
      }
    }
    const bootstrap = candidates.length === 0 && branchCount > 0 && branchCount === bootstrappedBranchCount;
    return {candidates, bootstrap, pipelineHealth};
  }

}
