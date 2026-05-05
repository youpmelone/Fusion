# Legal counter-lawsuit workflow orchestration

The counter-lawsuit prototype has a dashboard API control plane for queueing a guarded legal workflow run.

It does not verify legal claims by itself. It creates Fusion tasks, durable agents, safety workflow steps, and provenance documents so later QMD, Obsidian, CourtListener, artifact-generation, and attorney-verification work has a clear contract.

## Launch API

Start a run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs
```

The request body accepts:

```ts
{
  matterName: string;
  focus?: string;
  vaultScope?: string;
  sourceScope?: string;
  sourceQuery?: string;
  requestedArtifacts?: string[];
  codexSkillNames?: string[];
  safeguards: {
    citationSourceVerification: true;
    opposingCounselRedTeam: true;
    preserveLineage: true;
    humanVerificationRequired?: true;
  };
}
```

`matterName` is required.

The three safety acknowledgments must be true. If `codexSkillNames` is omitted, Fusion uses the default Codex legal skill list: `legal-research`, `legal-evidence-mining`, `legal-drafting`, and `opposing-counsel-red-team`.

## Launch response

The response keeps the FN-001 dashboard contract and adds orchestration details:

```ts
{
  runId: string;
  status: "queued";
  taskId: string;
  task: Task;
  documentKey: "counter-lawsuit-run";
  artifacts: Array<{ id: string; label: string; status: "queued"; documentKey: string; taskId: string }>;
  stageTasks: Array<{ id: string; stage: string; stageIndex: number; documentKey: string; dependencies: string[] }>;
  workflowStepIds: string[];
  agentIds: string[];
  artifactKeys: string[];
  safetyGates: string[];
  sourceScopeStatus: "specified" | "unspecified";
  codexSkillNames: string[];
  codexSkillSource: "default" | "user";
}
```

`taskId` and `task` point to the first stage task, the research memo.

## Status API

Fetch derived run status with:

```http
GET /api/legal-workflows/counter-lawsuit/runs/:runId
```

The status endpoint finds tasks whose `sourceMetadata.workflowRunId` matches the run ID. It returns the stage task statuses, artifact keys, safety gates, source scope status, and lineage document references.

Unknown run IDs return `404`.

## Generated stage DAG

Every stage task is created in `todo`. Dependencies control execution order:

1. Research memo → `research-memo`
2. Evidence ledger → `evidence-ledger`
3. Claim map → `claim-map`
4. Draft counter-lawsuit complaint → `draft-counter-lawsuit-complaint`
5. Opposing-counsel red-team report → `red-team-report`
6. Lineage/scoring log → `lineage-scoring-log`

Each task records `source.sourceType: "dashboard_ui"` and source metadata with the workflow kind, run ID, stage, stage index, expected artifact, Codex skills, skill source, source scope status, and required safety gates.

## Task documents

The root research memo task receives a `counter-lawsuit-run` document. Each stage task receives a `counter-lawsuit-stage` document.

Those documents preserve the stage prompt, expected output document key, upstream task IDs, safety gates, workflow step IDs, skill names, skill source, integration expectations, and draft-only safety boundary.

## Agents and Codex legal skills

The server creates or reuses durable legal workflow agents. It does not create ephemeral runtime agents for this workflow.

Agents are keyed by workflow role and Codex skill set, and `metadata.skills` stores the resolved skill names. Assigned stage tasks set `assignedAgentId`, so runtime skill selection can use the durable agent metadata.

## Safety workflow steps

Every generated stage task enables three prompt-mode pre-merge workflow steps:

- Citation/source verification
- Opposing-counsel red-team review
- Lineage preservation

The prompts require `REQUEST REVISION` for unsupported facts, unverified legal authorities, missing adversarial critique, or missing lineage.

## Optional source scope behavior

A launch can omit source scope and source query.

When no `vaultScope`, `sourceScope`, or `sourceQuery` is supplied, the run records `sourceScopeStatus: "unspecified"`. Generated prompts tell agents to treat source discovery as unverified until QMD MCP or Obsidian MCP mining supplies receipts.

`focus` narrows the legal theory or question, but it is not treated as a verified source scope by itself.

## Integration boundaries

This orchestration layer does not implement QMD MCP, Obsidian MCP, CourtListener lookups, or final legal artifact generation.

Stage prompts instruct agents to use those integrations when available and to mark unavailable integration results as unverified. Outputs are drafts only and are not promoted, reliable, or ready for use until citation/source verification, opposing-counsel red-team review, lineage preservation, and qualified human verification pass.
