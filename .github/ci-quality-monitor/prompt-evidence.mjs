import {MAX_RELATED_MECHANISM_CHARACTERS} from "./constants.mjs";
import {matchesFailure} from "./failure-identity.mjs";

export const MAX_AGENT_DOSSIER_CHARACTERS = 180_000;

function observations(dossier)
{
  const entries = [];
  for (const [failureIndex, failure] of dossier.failures.entries())
  {
    const prefix = `failures[${failureIndex}]`;
    for (const [index, value] of (failure.issueCandidates ?? []).entries())
    {
      entries.push({value, path: `${prefix}.issueCandidates[${index}]`, current: true});
    }
    for (const [index, value] of (failure.contextObservations ?? []).entries())
    {
      entries.push({value, path: `${prefix}.contextObservations[${index}]`, current: false});
    }
    for (const [relatedIndex, related] of (failure.relatedFailureSummaries ?? []).entries())
    {
      for (const [index, value] of (related.observations ?? []).entries())
      {
        entries.push({
          value, path: `${prefix}.relatedFailureSummaries[${relatedIndex}].observations[${index}]`, current: false
        });
      }
    }
  }
  for (const [index, value] of dossier.pipelineHealth.entries())
  {
    entries.push({value, path: `pipelineHealth[${index}]`, current: Boolean(value.actionable)});
  }
  return entries;
}

function countCoverage(dossier)
{
  const counts = {
    failures: dossier.failures.length,
    issueCandidates: 0,
    contextObservations: 0,
    relatedObservations: 0,
    matchingRelatedObservations: 0,
    pipelineHealth: dossier.pipelineHealth.length,
    actionablePipelineHealth: dossier.pipelineHealth.filter(item => item.actionable).length
  };
  for (const failure of dossier.failures)
  {
    const candidates = failure.issueCandidates ?? [];
    counts.issueCandidates += candidates.length;
    counts.contextObservations += (failure.contextObservations ?? []).length;
    for (const related of failure.relatedFailureSummaries ?? [])
    {
      const previous = related.observations ?? [];
      counts.relatedObservations += previous.length;
      counts.matchingRelatedObservations += previous.filter(item =>
        candidates.some(candidate => matchesFailure(candidate, item))).length;
    }
  }
  return counts;
}

function clipText(text)
{
  let end = MAX_RELATED_MECHANISM_CHARACTERS;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}

/**
 * Projects JSON evidence for the agent without changing the full artifact. The budget includes
 * JSON escaping and the projection's own coverage metadata, not just diagnostic string lengths.
 */
export function prepareAgentDossier(fullDossier, {
  maxCharacters = MAX_AGENT_DOSSIER_CHARACTERS,
  fullEvidenceArtifact = null
} = {})
{
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > MAX_AGENT_DOSSIER_CHARACTERS)
  {
    throw new RangeError(`maxCharacters must be between 1 and ${MAX_AGENT_DOSSIER_CHARACTERS}.`);
  }
  const fullJson = JSON.stringify(fullDossier);
  const projected = JSON.parse(fullJson);
  if (!Array.isArray(projected?.failures) || !Array.isArray(projected?.pipelineHealth))
  {
    throw new TypeError("The full dossier must contain failures and pipelineHealth arrays.");
  }
  const originalCounts = countCoverage(projected);
  const omissions = new Map();
  const record = (path, before, after, reason) =>
  {
    const oldJson = JSON.stringify(before) ?? "";
    const newJson = JSON.stringify(after) ?? "";
    if (oldJson === newJson) return;
    const groupedPath = path.replace(/\[\d+\]/g, "[]");
    const key = `${groupedPath}:${reason}`;
    const entry = omissions.get(key) ?? {
      path: groupedPath, reason, affectedFields: 0, omittedFields: 0, omittedItems: 0, omittedValueCharacters: 0
    };
    entry.affectedFields++;
    entry.omittedFields += after === undefined ? 1 : 0;
    entry.omittedItems += Array.isArray(before)
      ? Math.max(0, before.length - (Array.isArray(after) ? after.length : 0)) : 0;
    entry.omittedValueCharacters += Math.max(0, oldJson.length - newJson.length);
    omissions.set(key, entry);
  };
  const remove = (object, key, path, reason) =>
  {
    if (!object || !Object.hasOwn(object, key)) return;
    record(`${path}.${key}`, object[key], undefined, reason);
    delete object[key];
  };
  const trim = (object, key, path) =>
  {
    if (typeof object?.[key] !== "string" || object[key].length <= MAX_RELATED_MECHANISM_CHARACTERS) return;
    const shortened = clipText(object[key]);
    record(`${path}.${key}`, object[key], shortened, "diagnostic-character-limit");
    object[key] = shortened;
  };

  const allObservations = observations(projected);
  for (const {value, path} of allObservations)
  {
    trim(value, "mechanism", path);
    trim(value, "stackTrace", path);
    const console = value.consoleEvidence;
    if (console)
    {
      remove(console, "excerpt", `${path}.consoleEvidence`, "raw-console-in-full-artifact");
      if (Array.isArray(console.excerpts))
      {
        const ranges = console.excerpts.map(({text, ...range}) => range);
        record(`${path}.consoleEvidence.excerpts`, console.excerpts, ranges, "raw-console-projected-to-line-ranges");
        delete console.excerpts;
        console.lineRanges = ranges;
      }
      for (const [index, event] of (console.events ?? []).entries())
      {
        trim(event, "text", `${path}.consoleEvidence.events[${index}]`);
      }
    }
  }

  // Only current candidate locations are stable: optional related/context arrays can be filtered.
  const consoleSources = new Map();
  for (const {value, path} of allObservations.filter(entry => entry.path.includes(".issueCandidates[")))
  {
    if (!value.consoleEvidence) continue;
    const key = JSON.stringify([
      value.jobId, value.workItem ?? value.component, value.queue, value.consoleUrl, value.consoleEvidence
    ]);
    const source = consoleSources.get(key);
    if (source)
    {
      remove(value, "consoleEvidence", path, "duplicate-console-reference");
      value.consoleEvidenceRef = source;
    }
    else consoleSources.set(key, `${path}.consoleEvidence`);
  }

  projected.promptEvidence = {
    schemaVersion: 1,
    maxCharacters,
    fullDossierCharacters: fullJson.length,
    serializedCharacters: 0,
    truncated: false,
    requiredEvidenceRetained: true,
    fullEvidenceArtifact,
    recovery: "Omitted data remains in the full dossier artifact; console and artifact URLs identify original evidence.",
    consoleMetadataScope: "Console size and retention counters describe full-artifact evidence, not prompt retention.",
    omissionCharacterUnit: "JSON-serialized value characters, excluding property names and projection metadata",
    omissions: [],
    coverage: {}
  };
  const measure = () =>
  {
    const retainedCounts = countCoverage(projected);
    projected.promptEvidence.omissions = [...omissions.values()];
    projected.promptEvidence.truncated = omissions.size > 0;
    projected.promptEvidence.coverage = Object.fromEntries(Object.entries(originalCounts).map(([key, total]) =>
      [key, {total, retained: retainedCounts[key], omitted: total - retainedCounts[key]}]));
    // Updating the length field can change the number of digits in the serialized result.
    while (true)
    {
      const length = JSON.stringify(projected).length;
      if (projected.promptEvidence.serializedCharacters === length) return length;
      projected.promptEvidence.serializedCharacters = length;
    }
  };
  if (measure() <= maxCharacters) return projected;

  const clearArray = (object, key, path, reason) =>
  {
    if (!Array.isArray(object[key]) || object[key].length === 0) return;
    record(`${path}.${key}`, object[key], [], reason);
    object[key] = [];
  };
  const steps = [];
  for (const key of ["recentBuilds", "testFailures", "contextObservations"])
  {
    for (const [index, failure] of projected.failures.entries())
    {
      steps.push(() => clearArray(failure, key, `failures[${index}]`, "lower-priority-context-budget"));
    }
  }
  for (const [index, failure] of projected.failures.entries())
  {
    for (const [relatedIndex, related] of (failure.relatedFailureSummaries ?? []).entries())
    {
      const path = `failures[${index}].relatedFailureSummaries[${relatedIndex}]`;
      steps.push(() => clearArray(related, "taskFailures", path, "lower-priority-context-budget"));
      steps.push(() =>
      {
        if (!Array.isArray(related.observations)) return;
        const retained = related.observations.filter(previous => previous.actionable
          || (failure.issueCandidates ?? []).some(current => matchesFailure(current, previous)));
        record(`${path}.observations`, related.observations, retained, "unmatched-related-context-budget");
        related.observations = retained;
      });
    }
  }
  steps.push(() =>
  {
    const actionable = projected.pipelineHealth.filter(value => value.actionable);
    record("pipelineHealth", projected.pipelineHealth, actionable, "nonactionable-health-budget");
    projected.pipelineHealth = actionable;
  });
  // Diagnostics may be shortened, but current candidates, KBE patterns, and matching
  // related observations are never dropped to make an apparently complete prompt fit.
  for (const {value, path} of [...allObservations].sort((a, b) => Number(a.current) - Number(b.current)))
  {
    steps.push(() =>
    {
      if (!observations(projected).some(entry => entry.value === value)) return;
      remove(value, "stackTrace", path, "optional-diagnostic-budget");
      for (const key of ["hangEvidence", "dumpFailures"])
      {
        remove(value.consoleSummary, key, `${path}.consoleSummary`, "optional-diagnostic-budget");
      }
      for (const key of ["events", "lineRanges"])
      {
        remove(value.consoleEvidence, key, `${path}.consoleEvidence`, "optional-diagnostic-budget");
      }
    });
  }
  for (const step of steps)
  {
    step();
    if (measure() <= maxCharacters) return projected;
  }
  const error = new Error(
    `Required agent evidence is ${projected.promptEvidence.serializedCharacters} characters; budget is ${maxCharacters}. `
    + "Do not activate the agent; retain the full dossier artifact.");
  error.code = "AGENT_DOSSIER_BUDGET_EXCEEDED";
  error.maxCharacters = maxCharacters;
  error.requiredCharacters = projected.promptEvidence.serializedCharacters;
  throw error;
}
