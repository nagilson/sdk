export function normalizeTargetBranch(value)
{
  if (typeof value !== "string" || !value || /[\s~^:?*[\]\\]|\.\.|@\{/.test(value)) return null;
  if (value.startsWith("refs/") && !value.startsWith("refs/heads/")) return null;
  const branch = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  return branch.endsWith("/") || branch.endsWith(".") || branch.includes("//") ? null : branch;
}

export function getBuildContext(build)
{
  if (build.reason?.toLowerCase() !== "pullrequest")
  {
    return {targetBranch: build.sourceBranch?.startsWith("refs/heads/") ? build.sourceBranch : null,
      pullRequestNumber: null, targetBranchSource: "sourceBranch"};
  }
  const number = /^refs\/pull\/([1-9]\d*)\/merge$/.exec(build.sourceBranch ?? "")?.[1];
  let parameters = {};
  try
  {
    parameters = JSON.parse(build.parameters || "{}");
  } catch (error)
  {
    if (!(error instanceof SyntaxError)) throw error;
    return {targetBranch: null, pullRequestNumber: null, targetBranchSource: null,
      unavailable: "Invalid build parameters JSON"};
  }
  const numbers = [build.triggerInfo?.["pr.number"], parameters?.["system.pullRequest.pullRequestNumber"]]
    .filter(value => value !== undefined && value !== null && value !== "");
  const targets = [parameters?.["system.pullRequest.targetBranch"], parameters?.["system.pullRequest.targetBranchName"]]
    .filter(value => value !== undefined && value !== null && value !== "");
  const normalized = targets.map(normalizeTargetBranch);
  if (!number || !Number.isSafeInteger(Number(number)) || numbers.some(value => `${value}` !== number)
    || normalized.length === 0 || normalized.some(value => !value || value !== normalized[0]))
  {
    return {targetBranch: null, pullRequestNumber: number ? Number(number) : null, targetBranchSource: null,
      unavailable: "Missing or inconsistent build-time PR target/identity"};
  }
  return {targetBranch: normalized[0], pullRequestNumber: Number(number), targetBranchSource: "build.parameters"};
}

export function areIndependentBuilds(current, previous)
{
  return Boolean(current.commit && previous.commit && current.commit !== previous.commit
    && current.id !== previous.id
    && (!current.pullRequestNumber || current.pullRequestNumber !== previous.pullRequestNumber)
    && (!/^refs\/pull\//.test(current.branch ?? "") || current.branch !== previous.branch));
}
