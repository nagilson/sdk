async function findStateCheckpoint({github, context})
{
  const current = await github.rest.actions.getWorkflowRun({...context.repo, run_id: context.runId});
  const branch = context.ref.replace(/^refs\/heads\//, "");
  for (let page = 1; ; page++)
  {
    if (page > 5) throw new Error("Checkpoint search limit reached; refusing to reset admission state.");
    const {data} = await github.rest.actions.listArtifactsForRepo({
      ...context.repo, name: "ci-quality-state-v2", per_page: 100, page
    });
    const candidates = data.artifacts.filter(artifact => !artifact.expired
      && artifact.workflow_run?.id !== context.runId
      && artifact.workflow_run?.head_branch === branch)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    for (const artifact of candidates)
    {
      const run = await github.rest.actions.getWorkflowRun({...context.repo, run_id: artifact.workflow_run.id});
      if (run.data.workflow_id === current.data.workflow_id) return artifact.workflow_run.id;
    }
    if (data.artifacts.length < 100) break;
  }
  return null;
}

module.exports = {findStateCheckpoint};
