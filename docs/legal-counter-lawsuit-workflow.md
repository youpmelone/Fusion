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
  vaultMining: {
    runId: string;
    status: "completed" | "partial" | "unavailable" | "failed" | "not-run";
    researchRunId?: string;
    receiptCount: number;
    receiptsDocumentKey?: "vault-mining-receipts";
    statusDocumentKey?: "vault-mining-status";
    providerDiagnostics: Array<{ providerName: string; status: string; message: string }>;
    safetyNotice: string;
  };
}
```

`taskId` and `task` point to the first stage task, the research memo.

After stage tasks are created, the server attempts one bounded synchronous QMD MCP and Obsidian MCP vault-mining pass. A mining failure does not roll back the workflow run; it is returned as `vaultMining.status: "failed"` or provider diagnostics so the retry endpoint can be used.

## Vault-mining MCP setup

Fusion reads MCP command configuration from the project `.mcp.json` only. API callers cannot submit arbitrary MCP commands or config paths.

Use normal MCP server entries:

```json
{
  "mcpServers": {
    "qmd-mcp": { "command": "qmd", "args": ["mcp"] },
    "obsidian-vault": { "command": "obsidian-mcp", "args": ["--vault", "/path/to/vault"] }
  }
}
```

Recognized QMD server names are `qmd`, `qmd-mcp`, and `quantized-memory`. Recognized Obsidian server names are `obsidian`, `obsidian-mcp`, and `obsidian-vault`.

Environment variables and token-like command arguments are redacted from diagnostics, task documents, research metadata, and API responses.

The MCP client starts configured commands directly over stdio without a shell. It only permits read/search tools. QMD tools are `search`, `qmd_search`, `qmd.search`, `query`, `qmd_query`, and `qmd.query`. Obsidian tools are `search`, `obsidian_search`, `obsidian.search`, `simple_search`, `obsidian_simple_search`, `obsidian.get_file_contents`, `get_file_contents`, `read`, and `read_note`. Mutating names such as write, create, update, delete, move, rename, append, and patch are denied.

If QMD MCP is unavailable, Fusion performs a bounded fallback through the existing QMD project-memory backend. Fallback receipts are labeled `sourceSystem: "qmd-memory-fallback"`. Obsidian has no write or mutation fallback.

## Vault-mining retry API

Run or retry mining for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/vault-mining
```

The request body accepts only bounded query controls and provider/tool overrides:

```ts
{
  queries?: string[];
  maxQueries?: number;              // 1..10
  maxResultsPerProvider?: number;   // 1..20
  qmd?: { serverName?: string; searchToolName?: string };
  obsidian?: { serverName?: string; searchToolName?: string; readToolName?: string };
}
```

The response shape is the same `vaultMining` summary returned by launch and status. Invalid query arrays, out-of-range limits, unknown fields, or mutating tool names return `400`. Unknown run IDs return `404`.

## Status API

Fetch derived run status with:

```http
GET /api/legal-workflows/counter-lawsuit/runs/:runId
```

The status endpoint finds tasks whose `sourceMetadata.workflowRunId` matches the run ID. It returns the stage task statuses, artifact keys, safety gates, source scope status, lineage document references, and current vault-mining summary.

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

The research memo task also receives `vault-mining-receipts` after mining runs. This document is the required first source manifest for downstream research memo work. When providers are missing, partial, or unavailable, Fusion also writes `vault-mining-status` so the missing source path is visible instead of treated as success.

## Vault-mining receipt schema

Accepted receipts are persisted both as local `ResearchSource` entries and in the research-memo task document. Every accepted receipt uses this persisted-safe shape:

```ts
{
  receiptId: string;
  sourceSystem: "qmd-mcp" | "obsidian-mcp" | "qmd-memory-fallback";
  providerName: string;
  mcpServerName?: string;
  toolName: string;
  query: string;
  sourcePath: string;
  sourceUri?: string;
  lineStart?: number;
  lineEnd?: number;
  title?: string;
  excerpt: string;          // bounded and secret-redacted
  retrievedAt: string;
  hash: string;             // deterministic content hash
  verified: false;
  rawResultSummary?: string;
}
```

Hits without a usable source path are quarantined in diagnostics and are not persisted as evidence receipts. Full raw MCP payloads, full note bodies, Obsidian tokens, MCP environment values, and token-like strings are not persisted.

The linked `ResearchRun` uses trigger `legal-counter-lawsuit-vault-mining` with tags `legal-workflow`, `counter-lawsuit`, and `vault-mining`. Each receipt is stored as a `ResearchSource` with `type: "local"`, `reference: sourcePath`, bounded excerpt content, and receipt metadata.

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

This workflow now mines QMD MCP and Obsidian MCP for source-linked local receipts, but it does not verify the legal significance of the material.

It does not validate legal authorities, verify citations, generate the final research memo, evidence ledger, claim map, complaint draft, red-team report, or promote mined facts for filing. CourtListener authority validation remains a separate later integration.

Stage prompts instruct agents to use integrations when available and to mark unavailable integration results as unverified. Outputs and mined receipts are drafts or source manifests only. They are not promoted, reliable, or ready for use until citation/source verification, opposing-counsel red-team review, lineage preservation, and qualified human verification pass.
