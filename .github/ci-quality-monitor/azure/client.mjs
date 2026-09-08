import
{
  AZURE_API_VERSION,
  DEFAULT_BUILD_LIMIT,
  HISTORY_WINDOW_DAYS,
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGES,
  MAX_HISTORY_DETAILS,
  MAX_LOG_CHARACTERS,
  MAX_TEST_FAILURES
} from "../constants.mjs";
import {normalizeEvidenceText} from "../evidence-utils.mjs";
import {HttpClient} from "../http-client.mjs";
import {getBuildContext} from "../build-context.mjs";

function buildApiBase(pipeline)
{
  const organization = encodeURIComponent(pipeline.organization);
  const project = encodeURIComponent(pipeline.project);
  return `https://dev.azure.com/${organization}/${project}/_apis`;
}

function testApiBase(pipeline)
{
  const organization = encodeURIComponent(pipeline.organization);
  const project = encodeURIComponent(pipeline.project);
  return `https://vstmr.dev.azure.com/${organization}/${project}/_apis/test`;
}

export class AzureDevOpsClient
{
  constructor(pipeline, fetchImplementation = fetch)
  {
    this.pipeline = pipeline;
    this.http = new HttpClient(fetchImplementation);
    this.historyWindows = new Map();
  }

  async fetchResponse(url, accept = "application/json")
  {
    return this.http.response(url, accept);
  }

  async fetchJson(url)
  {
    return this.http.json(url);
  }

  async listBuilds(parameters)
  {
    const query = new URLSearchParams({
      definitions: `${this.pipeline.definitionId}`,
      "$top": `${DEFAULT_BUILD_LIMIT}`,
      "api-version": AZURE_API_VERSION,
      ...parameters
    });
    const result = await this.fetchJson(`${buildApiBase(this.pipeline)}/build/builds?${query}`);
    return result.value ?? [];
  }

  listCompletedBuilds(branch)
  {
    return this.listBuilds({branchName: branch, statusFilter: "completed", queryOrder: "finishTimeDescending"});
  }

  listRecentBuilds(branch)
  {
    return this.listBuilds({branchName: branch, queryOrder: "queueTimeDescending"});
  }

  listCompletedBuildWindow(through = new Date().toISOString())
  {
    if (!this.historyWindows.has(through))
    {
      this.historyWindows.set(through, this.fetchCompletedBuildWindow(through));
    }
    return this.historyWindows.get(through);
  }

  async fetchCompletedBuildWindow(through)
  {
    const end = new Date(through);
    if (!Number.isFinite(end.getTime())) throw new Error(`Invalid history end time: ${through}`);
    const start = new Date(end.getTime() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
    const builds = [];
    const unavailableTargets = [];
    let continuationToken;
    let pages = 0;
    let details = 0;
    do
    {
      const query = new URLSearchParams({
        definitions: `${this.pipeline.definitionId}`, repositoryId: this.pipeline.repository,
        repositoryType: "GitHub", statusFilter: "completed", queryOrder: "finishTimeDescending",
        minTime: start, maxTime: end.toISOString(), "$top": `${HISTORY_PAGE_SIZE}`,
        "api-version": AZURE_API_VERSION
      });
      if (continuationToken) query.set("continuationToken", continuationToken);
      const response = await this.fetchResponse(`${buildApiBase(this.pipeline)}/build/builds?${query}`);
      const page = (await response.json()).value ?? [];
      for (let build of page)
      {
        if (build.definition?.id !== this.pipeline.definitionId
          || build.repository?.id?.toLowerCase() !== this.pipeline.repository.toLowerCase()) continue;
        if (build.reason?.toLowerCase() === "pullrequest" && !build.parameters && details < MAX_HISTORY_DETAILS)
        {
          build = await this.getBuild(build.id);
          details++;
        }
        const context = getBuildContext(build);
        if (context.unavailable) unavailableTargets.push({buildId: build.id, reason: context.unavailable});
        builds.push(build);
      }
      pages++;
      continuationToken = response.headers?.get("x-ms-continuationtoken");
    } while (continuationToken && pages < MAX_HISTORY_PAGES);
    return {
      builds: [...new Map(builds.map(build => [build.id, build])).values()],
      coverage: {from: start, through: end.toISOString(), pages, scannedBuilds: builds.length,
        truncated: Boolean(continuationToken), unavailableTargets, detailRequests: details}
    };
  }

  async listTargetBranchHistory(targetBranch, through)
  {
    const window = await this.listCompletedBuildWindow(through);
    return {...window, builds: window.builds.filter(build => getBuildContext(build).targetBranch === targetBranch)};
  }

  async findPullRequestBuildByHead(headSha, pullRequestNumber = null)
  {
    const parameters = {statusFilter: "completed", queryOrder: "finishTimeDescending"};
    if (pullRequestNumber) parameters.branchName = `refs/pull/${pullRequestNumber}/merge`;
    const builds = await this.listBuilds(parameters);
    return builds.find(build => build.reason?.toLowerCase() === "pullrequest"
      && build.triggerInfo?.["pr.sourceSha"] === headSha);
  }

  getBuild(buildId)
  {
    const url = `${buildApiBase(this.pipeline)}/build/builds/${encodeURIComponent(buildId)}?api-version=${AZURE_API_VERSION}`;
    return this.fetchJson(url);
  }

  async getTimeline(buildId)
  {
    const url = `${buildApiBase(this.pipeline)}/build/builds/${buildId}/timeline?api-version=${AZURE_API_VERSION}`;
    const response = await this.fetchResponse(url);
    return response.status === 204 ? {records: []} : response.json();
  }

  async getFailureLog(buildId, logId, logUrl)
  {
    if (!logId) return null;
    const url = logUrl ?? `${buildApiBase(this.pipeline)}/build/builds/${buildId}/logs/${logId}?api-version=${AZURE_API_VERSION}`;
    const response = await this.fetchResponse(url, "text/plain");
    const text = await response.text();
    return normalizeEvidenceText(text.slice(-MAX_LOG_CHARACTERS));
  }

  async getTestFailures(buildId)
  {
    const runsUrl = `${testApiBase(this.pipeline)}/runs?buildIds=${buildId}&api-version=${AZURE_API_VERSION}`;
    const runs = (await this.fetchJson(runsUrl)).value ?? [];
    const failures = [];
    for (const run of runs.filter(candidate => candidate.totalTests > candidate.passedTests).slice(0, MAX_TEST_FAILURES))
    {
      const query = new URLSearchParams({
        outcomes: "Failed,Aborted,Timeout",
        "$top": `${MAX_TEST_FAILURES}`,
        "api-version": AZURE_API_VERSION
      });
      const url = `${testApiBase(this.pipeline)}/runs/${run.id}/results?${query}`;
      const results = (await this.fetchJson(url)).value ?? [];
      failures.push(...results.slice(0, MAX_TEST_FAILURES - failures.length).map(result => ({
        runId: run.id,
        runName: run.name,
        test: result.testCaseTitle,
        outcome: result.outcome,
        error: normalizeEvidenceText(result.errorMessage),
        stackTrace: normalizeEvidenceText(result.stackTrace)
      })));
      if (failures.length >= MAX_TEST_FAILURES) break;
    }
    return failures;
  }
}
