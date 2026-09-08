import {createPipelineObservation, createTaskObservations} from "./azure/observations.mjs";
import {applyKbeRecurrence, getTimelineFailuresFromRecords} from "./collector-policy.mjs";
import {
  MAX_HELIX_REFERENCES,
  MAX_RELATED_BUILDS,
  MAX_RELATED_BUILD_SCAN,
  MAX_RELATED_CONTEXT_OBSERVATIONS,
  MAX_RELATED_HELIX_REFERENCES,
  MAX_RELATED_MECHANISM_CHARACTERS,
  MAX_TASK_LOGS
} from "./constants.mjs";
import {createBuildSummary, isFailedBuild, normalizeEvidenceText} from "./evidence-utils.mjs";
import {areIndependentBuilds} from "./build-context.mjs";
import {matchesFailure} from "./failure-identity.mjs";

export class FailureEvidenceCollector
{
  constructor(getAzureClient, helixEvidenceClient)
  {
    this.getAzureClient = getAzureClient;
    this.helixEvidence = helixEvidenceClient;
  }

  async collectRelatedFailureEvidence(pipeline, currentBuild, history, currentObservations)
  {
    const related = [];
    const current = createBuildSummary(currentBuild);
    const identities = new Set();
    const failedBuilds = history
      .filter(build => isFailedBuild(build) && areIndependentBuilds(current, createBuildSummary(build)))
      .filter(build =>
      {
        const summary = createBuildSummary(build);
        const key = summary.pullRequestNumber ? `pr:${summary.pullRequestNumber}` : `commit:${summary.commit}`;
        if (identities.has(key)) return false;
        identities.add(key);
        return true;
      });
    const workItems = new Set(currentObservations.map(observation =>
      observation.workItem ?? (observation.kind === "helix-work-item" ? observation.component : null))
      .filter(Boolean).map(name => name.replace(/\.dll\.\d+$/, ".dll")));
    let scanned = 0;
    for (const build of failedBuilds.slice(0, MAX_RELATED_BUILD_SCAN))
    {
      if (related.length >= MAX_RELATED_BUILDS) break;
      scanned++;
      try
      {
        const timeline = await this.getAzureClient(pipeline).getTimeline(build.id);
        const timelineFailures = getTimelineFailuresFromRecords(timeline.records);
        const references = timelineFailures.flatMap(failure => failure.helixReferences ?? []);
        if (workItems.size && !references.some(reference =>
          workItems.has(reference.workItem.replace(/\.dll\.\d+$/, ".dll")))) continue;
        const relevantFailures = workItems.size ? timelineFailures.map(failure => ({
          ...failure, helixReferences: (failure.helixReferences ?? []).filter(reference =>
            workItems.has(reference.workItem.replace(/\.dll\.\d+$/, ".dll")))
        })) : timelineFailures;
        const observations = await this.helixEvidence.collectObservations(
          relevantFailures, MAX_RELATED_HELIX_REFERENCES);
        related.push({
          build: createBuildSummary(build),
          taskFailures: timelineFailures.map(failure => ({
            name: failure.name,
            path: failure.path,
            issues: failure.issues
          })),
          observations: deduplicateObservations(observations)
        });
      } catch (error)
      {
        related.push({build: createBuildSummary(build), unavailable: normalizeEvidenceText(error.message)});
      }
    }
    return {summaries: related, coverage: {
      independentFailedBuilds: failedBuilds.length, scannedTimelines: scanned,
      collectedBuilds: related.length, unscannedBuilds: failedBuilds.length - scanned,
      truncated: scanned < failedBuilds.length
    }};
  }

  async collectFailureEvidence(pipeline, build, history, candidate = {})
  {
    const azure = this.getAzureClient(pipeline);
    const detailedBuild = build.validationResults ? build : await azure.getBuild(build.id);
    const timeline = await azure.getTimeline(build.id);
    const timelineFailures = getTimelineFailuresFromRecords(timeline.records);
    const pipelineObservation = createPipelineObservation(detailedBuild, timeline.records ?? []);
    const helixObservations = await this.helixEvidence.collectObservations(timelineFailures, MAX_HELIX_REFERENCES);
    const relatedEvidence = await this.collectRelatedFailureEvidence(pipeline, build, history, helixObservations);
    const relatedFailureSummaries = relatedEvidence.summaries;
    const logFailures = await this.collectTaskLogs(azure, build.id, timelineFailures);
    const taskObservations = createTaskObservations(
      timelineFailures,
      new Map(logFailures.filter(failure => failure.text).map(failure => [failure.logId, failure.text])));
    const observations = deduplicateObservations(applyKbeRecurrence(
      [pipelineObservation, ...taskObservations, ...helixObservations].filter(Boolean),
      relatedFailureSummaries,
      createBuildSummary(build)));
    const withRecurrence = observations.map(observation =>
    {
      const matchingBuilds = relatedFailureSummaries.filter(summary =>
        summary.observations?.some(previous => matchesFailure(observation, previous))).map(summary => summary.build);
      const recurrence = {matchingBuilds, recurring: matchingBuilds.length > 0,
        basis: observation.failureFamilyFingerprint ? "failure-family-not-root-cause" : "exact-fingerprint"};
      return {...observation, recurrence, actionable: observation.actionable
        && (!candidate.requiresIndependentRecurrence || recurrence.recurring)};
    });
    return {
      pipeline,
      build: createBuildSummary(build),
      monitoringScope: candidate.monitoringScope ?? null,
      priority: candidate.priority ?? null,
      auditContext: candidate.auditContext ?? null,
      mergedPullRequest: candidate.mergedPullRequest ?? null,
      targetBranch: candidate.targetBranch ?? createBuildSummary(build).targetBranch,
      requiresIndependentRecurrence: candidate.requiresIndependentRecurrence ?? false,
      historyCoverage: candidate.historyCoverage ?? null,
      relatedEvidenceCoverage: relatedEvidence.coverage,
      evidenceLimits: {relatedBuilds: MAX_RELATED_BUILDS, relatedBuildsScanned: MAX_RELATED_BUILD_SCAN,
        currentHelixReferences: MAX_HELIX_REFERENCES, relatedHelixReferences: MAX_RELATED_HELIX_REFERENCES,
        taskLogs: MAX_TASK_LOGS},
      recentBuilds: history.map(createBuildSummary),
      issueCandidates: withRecurrence.filter(observation => observation.actionable),
      contextObservations: withRecurrence.filter(observation => !observation.actionable),
      relatedFailureSummaries: compactRelatedFailureSummaries(relatedFailureSummaries, withRecurrence),
      testFailures: await this.collectAzureTestFailures(azure, build.id)
    };
  }

  async collectAzureTestFailures(azure, buildId)
  {
    try
    {
      return await azure.getTestFailures(buildId);
    } catch (error)
    {
      return [{unavailable: normalizeEvidenceText(error.message)}];
    }
  }

  async collectTaskLogs(azure, buildId, timelineFailures)
  {
    const logs = [];
    const failedTasks = [...new Map(
      timelineFailures.filter(candidate => candidate.type === "Task" && candidate.logId)
        .map(candidate => [candidate.logId, candidate])).values()].slice(0, MAX_TASK_LOGS);
    for (const failure of failedTasks)
    {
      try
      {
        logs.push({
          name: failure.name,
          logId: failure.logId,
          text: await azure.getFailureLog(buildId, failure.logId, failure.logUrl)
        });
      } catch (error)
      {
        logs.push({name: failure.name, unavailable: normalizeEvidenceText(error.message)});
      }
    }
    return logs;
  }
}

function deduplicateObservations(observations)
{
  return [...new Map(observations.map(observation => [
    JSON.stringify([observation.fingerprint ?? `${observation.kind}:${observation.component}:${observation.mechanism}`,
      observation.jobId ?? observation.logId, observation.workItem ?? observation.component]),
    observation
  ])).values()];
}

function compactRelatedFailureSummaries(summaries, currentObservations)
{
  return summaries.map(summary => ({
    ...summary,
    observationCoverage: {total: (summary.observations ?? []).length,
      retained: Math.min((summary.observations ?? []).length, MAX_RELATED_CONTEXT_OBSERVATIONS),
      omitted: Math.max(0, (summary.observations ?? []).length - MAX_RELATED_CONTEXT_OBSERVATIONS)},
    observations: [...(summary.observations ?? [])]
      .sort((left, right) => observationRelevance(right, currentObservations)
        - observationRelevance(left, currentObservations))
      .slice(0, MAX_RELATED_CONTEXT_OBSERVATIONS)
      .map(compactRelatedObservation)
  }));
}

function observationRelevance(observation, currentObservations)
{
  return currentObservations.some(current => matchesFailure(current, observation)
    || (current.component === observation.component
      && current.mechanismFingerprint && current.mechanismFingerprint === observation.mechanismFingerprint)) ? 1 : 0;
}

function compactRelatedObservation(observation)
{
  const {
    kind, phase, failureType, evidenceSources, component, mechanism, fingerprint,
    mechanismFingerprint, failureFamilyFingerprint, actionable, workItem, jobId, queue, outcome, exitCode, state,
    consoleSummary, consoleUrl, artifacts, artifactSelection, testResultEvidence, consoleEvidence
  } = observation;
  return {
    kind, phase, failureType, evidenceSources, component,
    mechanism: normalizeEvidenceText(mechanism, MAX_RELATED_MECHANISM_CHARACTERS),
    mechanismTruncated: mechanism.length > MAX_RELATED_MECHANISM_CHARACTERS,
    fingerprint, mechanismFingerprint, failureFamilyFingerprint, actionable, workItem, jobId, queue, outcome, exitCode, state,
    consoleSummary, consoleUrl, artifacts, artifactSelection, testResultEvidence, consoleEvidence
  };
}
