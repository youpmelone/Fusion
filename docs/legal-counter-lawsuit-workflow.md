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
  authorityValidation: {
    runId: string;
    status: "completed" | "partial" | "unavailable" | "no-candidates" | "failed" | "not-run";
    researchRunId?: string;
    candidateCount: number;
    validatedCount: number;
    unmatchedCount: number;
    diagnostics: Array<{ providerName: "courtlistener"; status: string; message: string }>;
    authorityValidationDocumentKey?: "courtlistener-authority-validation";
    statusDocumentKey?: "courtlistener-status";
    safetyNotice: string;
  };
}
```

`taskId` and `task` point to the first stage task, the research memo.

After stage tasks are created, the server attempts one bounded synchronous QMD MCP and Obsidian MCP vault-mining pass. A mining failure does not roll back the workflow run; it is returned as `vaultMining.status: "failed"` or provider diagnostics so the retry endpoint can be used.

After vault mining is attempted, Fusion also runs a bounded CourtListener authority-validation pass when launch text, explicit retry candidates, vault receipts, or stage documents provide citation or authority candidates. CourtListener failure also does not roll back the workflow run. Missing, unmatched, ambiguous, unavailable, or no-candidate results remain visible in `authorityValidation` and are not treated as legal success.

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

## CourtListener setup

CourtListener validation uses the public CourtListener REST API by default at `https://www.courtlistener.com/api/rest/v4`.

Set `COURTLISTENER_API_TOKEN` or `COURTLISTENER_TOKEN` in the dashboard process environment to send `Authorization: Token <token>`. The token is optional, and it is never accepted from public request bodies.

Fusion redacts token-like values from provider diagnostics, task documents, research metadata, and API responses. CourtListener base URLs, headers, tokens, and raw fetch options are not accepted through the launch or retry APIs.

CourtListener validation means citation and authority lookup evidence only. It does not Shepardize, verify good-law status, validate legal conclusions, check final filing citation format, decide filing readiness, or replace attorney judgment.

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

## CourtListener authority-validation retry API

Run or retry authority validation for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/authority-validation
```

The request body accepts only bounded candidate fields:

```ts
{
  citations?: string[];              // at most 25 entries, each at most 300 chars
  queries?: string[];                // at most 25 entries, each at most 300 chars
  text?: string;                     // at most 8000 chars, scanned for citations
  maxCandidates?: number;            // 1..25
  maxResultsPerCandidate?: number;   // 1..10
}
```

The response shape is the same `authorityValidation` summary returned by launch and status. Invalid fields, oversized arrays, oversized text, and out-of-range limits return `400`. Unknown run IDs return `404`.

A no-candidate run writes `courtlistener-status` with `status: "no-candidates"`. This is visible and retryable; it is not successful validation.

## Status API

Fetch derived run status with:

```http
GET /api/legal-workflows/counter-lawsuit/runs/:runId
```

The status endpoint finds tasks whose `sourceMetadata.workflowRunId` matches the run ID. It returns the stage task statuses, artifact keys, safety gates, source scope status, lineage document references, the current vault-mining summary, and the current CourtListener authority-validation summary.

The `authorityValidation` status includes the research run ID, candidate count, matched count, unmatched/ambiguous/unavailable count, diagnostics, safety notice, and document key references for `courtlistener-authority-validation` and `courtlistener-status` when present.

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

After authority validation runs, the research memo task receives `courtlistener-authority-validation`. When CourtListener is unavailable, partial, has no candidates, has unmatched candidates, or needs retry, Fusion also writes `courtlistener-status`. Research memo prompts and downstream stage prompts instruct agents to read `courtlistener-authority-validation` when it exists and to treat missing, unmatched, ambiguous, or unavailable validation as unresolved authority gaps.

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

## CourtListener authority-validation document schema

The `courtlistener-authority-validation` document contains a human-readable summary and a machine-readable JSON manifest:

```ts
{
  safetyNotice: string;
  researchRunId?: string;
  candidates: Array<{ input: string; inputType: "citation" | "query"; source: string }>;
  validationRecords: Array<{
    recordId: string;
    input: string;
    inputType: "citation" | "query";
    status: "matched" | "not-found" | "ambiguous" | "unavailable";
    normalizedCitation?: string;
    caseName?: string;
    court?: string;
    dateFiled?: string;
    clusterId?: string;
    opinionId?: string;
    courtListenerUrl?: string;
    absoluteUrl?: string;
    retrievedAt: string;
    hash: string;
    source: "courtlistener";
    legalConclusionVerified: false;
    promoted: false;
    rawResultSummary?: string;
  }>;
  rejectedCandidates: Array<{ input: string; inputType?: string; source: string; reason: string }>;
  diagnostics: Array<{ providerName: "courtlistener"; status: string; message: string }>;
}
```

Only `status: "matched"` records with a CourtListener URL or API-derived canonical URL are persisted as web `ResearchSource` entries. Ambiguous, not-found, unavailable, and citation-only echoes remain visible in the manifest but are unresolved and are not promoted as validated authority sources.

The linked `ResearchRun` uses trigger `legal-counter-lawsuit-courtlistener-validation` with tags `legal-workflow`, `counter-lawsuit`, and `courtlistener`. Matched authorities are stored as `ResearchSource` entries with `type: "web"`, `reference` set to the CourtListener URL or API-derived canonical URL, bounded excerpt content, and safe validation-record metadata.

Full raw CourtListener payloads, authorization headers, API tokens, token-like provider errors, and unbounded response bodies are not persisted.

## Agents and Codex legal skills

The server creates or reuses durable legal workflow agents. It does not create ephemeral runtime agents for this workflow.

Agents are keyed by workflow role and Codex skill set, and `metadata.skills` stores the resolved skill names. Assigned stage tasks set `assignedAgentId`, so runtime skill selection can use the durable agent metadata.

## Safety workflow steps

Every generated stage task enables three prompt-mode pre-merge workflow steps:

- Citation/source verification
- Opposing-counsel red-team review
- Lineage preservation

The citation/source prompt checks `courtlistener-authority-validation` when legal authorities are cited and the document exists.

It requires `REQUEST REVISION` when an authority is used as support without a matched CourtListener record, or when missing, unmatched, ambiguous, or unavailable CourtListener results are presented as support. Explicitly labeled unverified authority notes may remain only as unresolved research gaps; they do not satisfy the completion gate as support.

## Optional source scope behavior

A launch can omit source scope and source query.

When no `vaultScope`, `sourceScope`, or `sourceQuery` is supplied, the run records `sourceScopeStatus: "unspecified"`. Generated prompts tell agents to treat source discovery as unverified until QMD MCP or Obsidian MCP mining supplies receipts.

`focus` narrows the legal theory or question, but it is not treated as a verified source scope by itself.

## Integration boundaries

This workflow now mines QMD MCP and Obsidian MCP for source-linked local receipts and uses CourtListener for bounded authority lookup when candidates are available.

CourtListener can confirm that a citation or query maps to a CourtListener record or candidate match. It does not Shepardize, determine good-law status, verify legal conclusions, check final filing citation format, decide filing readiness, generate filings, or replace attorney judgment.

Stage prompts instruct agents to use integrations when available and to mark unavailable integration results as unverified. Outputs, mined receipts, and authority-validation records are drafts or source manifests only. They are not promoted, reliable, or ready for use until citation/source verification, opposing-counsel red-team review, lineage preservation, and qualified human verification pass.
