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
  researchMemo: {
    runId: string;
    status: "completed" | "partial" | "blocked" | "failed" | "not-run";
    memoDocumentKey?: "research-memo";
    statusDocumentKey?: "research-memo-status";
    evidenceCount: number;
    authorityCount: number;
    conclusionCount: number;
    sourcePathCount: number;
    diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
    safetyNotice: string;
  };
  evidenceLedger: {
    runId: string;
    status: "completed" | "partial" | "blocked" | "failed" | "not-run";
    ledgerDocumentKey?: "evidence-ledger";
    statusDocumentKey?: "evidence-ledger-status";
    factCount: number;
    sourceLinkCount: number;
    claimLinkCount: number;
    unresolvedGapCount: number;
    citationStatusCounts: Record<string, number>;
    confidenceCounts: Record<"high" | "medium" | "low" | "unsupported", number>;
    diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; factId?: string }>;
    safetyNotice: string;
  };
  claimMap: {
    runId: string;
    status: "completed" | "partial" | "blocked" | "failed" | "not-run";
    claimMapDocumentKey?: "claim-map";
    statusDocumentKey?: "claim-map-status";
    claimCount: number;
    elementCount: number;
    allegationCount: number;
    supportingEvidenceCount: number;
    missingProofCount: number;
    unresolvedGapCount: number;
    diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; claimId?: string; elementId?: string; allegationId?: string; factId?: string }>;
    safetyNotice: string;
  };
  draftComplaint: {
    runId: string;
    status: "completed" | "partial" | "blocked" | "failed" | "not-run";
    draftComplaintDocumentKey?: "draft-counter-lawsuit-complaint";
    statusDocumentKey?: "draft-counter-lawsuit-complaint-status";
    sectionCount: number;
    paragraphCount: number;
    claimDraftCount: number;
    sourceReferenceCount: number;
    sourcePathCount: number;
    missingProofCount: number;
    unresolvedGapCount: number;
    diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; claimId?: string; elementId?: string; allegationId?: string; paragraphId?: string }>;
    safetyNotice: string;
  };
  redTeamReport: {
    runId: string;
    status: "completed" | "partial" | "blocked" | "failed" | "stale" | "not-run";
    redTeamReportDocumentKey?: "red-team-report";
    statusDocumentKey?: "red-team-report-status";
    findingCount: number;
    mtdAttackCount: number;
    citationIssueCount: number;
    revisionRecommendationCount: number;
    unresolvedBlockerCount: number;
    reviewedParagraphCount: number;
    reviewedClaimCount: number;
    diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; paragraphId?: string; claimDraftId?: string; findingId?: string }>;
    safetyNotice: string;
  };
}
```

`taskId` and `task` point to the first stage task, the research memo.

After stage tasks are created, the server attempts one bounded synchronous QMD MCP and Obsidian MCP vault-mining pass. A mining failure does not roll back the workflow run; it is returned as `vaultMining.status: "failed"` or provider diagnostics so the retry endpoint can be used.

After vault mining is attempted, Fusion also runs a bounded CourtListener authority-validation pass when launch text, explicit retry candidates, vault receipts, or stage documents provide citation or authority candidates. CourtListener failure also does not roll back the workflow run. Missing, unmatched, ambiguous, unavailable, or no-candidate results remain visible in `authorityValidation` and are not treated as legal success.

After vault mining and CourtListener validation are attempted, Fusion generates the first downstream artifact: a draft `research-memo` task document on the research-memo stage task. The memo is deterministic from persisted `vault-mining-receipts`, `vault-mining-status`, `courtlistener-authority-validation`, and `courtlistener-status` documents. API callers cannot submit memo text, legal conclusions, source manifests, source paths, CourtListener records, external command configuration, tokens, headers, or raw fetch options.

After research memo generation is attempted, Fusion generates the structured `evidence-ledger` task document on the evidence-ledger stage task. The ledger is deterministic from persisted `research-memo` and `research-memo-status` documents only. API callers cannot submit ledger text, fact rows, claim mappings, confidence scores, citation statuses, source manifests, source paths, CourtListener records, external command configuration, tokens, headers, or raw fetch options.

After evidence ledger generation is attempted, Fusion generates the structured `claim-map` task document on the claim-map stage task. The claim map is deterministic from persisted `evidence-ledger` and `evidence-ledger-status` documents, with safe research memo conclusion labels used only for labels. API callers cannot submit claim-map text, legal elements, allegations, evidence mappings, confidence scores, source paths, CourtListener records, external commands, tokens, headers, or raw fetch options.

After claim-map generation is attempted, Fusion generates the deterministic `draft-counter-lawsuit-complaint` task document on the draft-complaint stage task. The draft complaint is built only from the persisted `claim-map` and `claim-map-status` documents. API callers cannot submit pleading text, legal theories, parties, jurisdiction, venue, damages, requested relief, source manifests, source paths, CourtListener records, external commands, tokens, headers, or raw fetch options from the request body.

Complaint draft generation is best-effort during launch. A draft failure does not roll back the workflow run; the launch response returns `draftComplaint.status: "failed"`, `"blocked"`, or `"partial"` with diagnostics, and the retry endpoint can regenerate from the persisted prerequisite documents.

After draft complaint generation is attempted, Fusion generates the deterministic `red-team-report` task document on the opposing-counsel red-team stage task. The report is built only from persisted `draft-counter-lawsuit-complaint`, `draft-counter-lawsuit-complaint-status`, `claim-map`, and `claim-map-status` documents. API callers cannot submit report text, attack categories, defenses, legal theories, source paths, confidence scores, citation records, revision text, external commands, CourtListener tokens, headers, or raw fetch options from the request body.

Red-team report generation is best-effort during launch. A report failure does not roll back the workflow run; the launch response returns `redTeamReport.status: "failed"`, `"blocked"`, `"partial"`, or `"stale"` with diagnostics, and the retry endpoint can regenerate from the persisted prerequisite documents. Older runs that predate the red-team stage return `redTeamReport.status: "not-run"`.

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

## Research memo retry API

Generate or retry the draft research memo for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/research-memo
```

The request body accepts only:

```ts
{
  force?: boolean;
}
```

Unknown fields return `400`. Unknown run IDs return `404`.

The response shape is the same `researchMemo` summary returned by launch and status. `force: true` asks Fusion to regenerate from the persisted prerequisite documents, but it still does not accept generated memo text, conclusions, source paths, CourtListener records, or external provider configuration from the request body.

## Evidence ledger retry API

Generate or retry the structured evidence ledger for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/evidence-ledger
```

The request body accepts only:

```ts
{
  force?: boolean;
}
```

Unknown fields return `400`. Unknown run IDs return `404`.

The response shape is the same `evidenceLedger` summary returned by launch and status. `force: true` asks Fusion to regenerate from persisted research memo documents, but it still does not accept generated ledger text, fact rows, claim mappings, confidence scores, source paths, citation statuses, CourtListener records, or provider configuration from the request body.

## Claim map retry API

Generate or retry the structured claim map for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/claim-map
```

The request body accepts only:

```ts
{
  force?: boolean;
}
```

Unknown fields return `400`. Unknown run IDs return `404`.

The response shape is the same `claimMap` summary returned by launch and status. `force: true` asks Fusion to regenerate from persisted evidence ledger documents, but it still does not accept generated claim-map text, legal elements, allegations, evidence mappings, source paths, confidence scores, CourtListener records, external commands, tokens, headers, or raw fetch options from the request body.

## Draft complaint retry API

Generate or retry the draft counter-lawsuit complaint scaffold for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/draft-counter-lawsuit-complaint
```

The request body accepts only:

```ts
{
  force?: boolean;
}
```

Unknown fields return `400`. Unknown run IDs return `404`.

The response shape is the same `draftComplaint` summary returned by launch and status. `force: true` asks Fusion to regenerate from persisted claim-map documents, but it still does not accept generated complaint text, pleading sections, legal theories, parties, jurisdiction, venue, relief, source manifests, source paths, CourtListener records, external commands, tokens, headers, or raw fetch options from the request body.

## Red-team report retry API

Generate or retry the opposing-counsel red-team report for an existing run with:

```http
POST /api/legal-workflows/counter-lawsuit/runs/:runId/red-team-report
```

The request body accepts only:

```ts
{
  force?: boolean;
}
```

Unknown fields return `400`. Unknown run IDs return `404`.

The response shape is the same `redTeamReport` summary returned by launch and status. `force: true` asks Fusion to regenerate from persisted complaint and claim-map documents, but it still does not accept report text, attack categories, defenses, legal theories, revision text, source paths, confidence scores, CourtListener records, external commands, tokens, headers, or raw fetch options from the request body.

Red-team retry is deterministic and prerequisite-driven:

- `blocked` means a reviewable draft complaint or required manifest is missing, malformed, or already blocked upstream.
- `partial` means Fusion produced a report but unresolved findings, citation/source issues, missing proof, placeholder pleading fields, or human verification requirements remain.
- `stale` means a companion status document or upstream status says the primary report cannot be treated as current completed critique.
- `failed` means report generation itself failed; diagnostics are redacted and bounded.
- `completed` still means draft-only issue spotting, not legal advice, legal verification, good-law review, citation-format validation, attorney review, or filing readiness.

## Status API

Fetch derived run status with:

```http
GET /api/legal-workflows/counter-lawsuit/runs/:runId
```

The status endpoint finds tasks whose `sourceMetadata.workflowRunId` matches the run ID. It returns the stage task statuses, artifact keys, safety gates, source scope status, lineage document references, the current vault-mining summary, the current CourtListener authority-validation summary, the current research memo summary, the current evidence ledger summary, the current claim-map summary, the current draft complaint summary, and the current red-team report summary.

The `authorityValidation` status includes the research run ID, candidate count, matched count, unmatched/ambiguous/unavailable count, diagnostics, safety notice, and document key references for `courtlistener-authority-validation` and `courtlistener-status` when present.

The `researchMemo` status includes status, memo document key, status document key when present, evidence count, authority count, conclusion count, source-path count, diagnostics, and safety notice. If only `research-memo-status` exists, status preserves that persisted blocker or failure instead of recomputing success from upstream prerequisites. If neither memo document exists, status is `not-run`.

The `evidenceLedger` status includes status, ledger document key, status document key when present, fact count, source-link count, preliminary claim-link count, unresolved gap count, citation-status counts, confidence counts, diagnostics, and safety notice. If `evidence-ledger-status` reports blocked, partial, failed, stale, or unresolved prerequisites, status preserves that blocker instead of treating a stale primary ledger as completed support. If neither ledger document exists, status is `not-run`.

The `claimMap` status includes status, claim-map document key, status document key when present, claim count, element count, allegation count, supporting-evidence count, missing-proof count, unresolved gap count, diagnostics, and safety notice. If `claim-map-status` reports blocked, partial, failed, stale, or unresolved prerequisites, status preserves that blocker instead of treating a stale primary claim map as completed support. Older runs without a claim-map stage return `claimMap.status: "not-run"` while preserving earlier summaries.

The `draftComplaint` status includes status, draft complaint document key, status document key when present, section count, numbered paragraph count, claim-draft count, source-reference count, source-path count, missing-proof count, unresolved gap count, diagnostics, and safety notice. If `draft-counter-lawsuit-complaint-status` reports blocked, partial, failed, stale, or unresolved prerequisites, status preserves that blocker instead of treating a stale primary complaint document as completed support. Older runs without a draft-complaint stage return `draftComplaint.status: "not-run"` while preserving earlier summaries.

The `redTeamReport` status includes status, red-team report document key, status document key when present, finding count, candidate MTD attack count, citation/source issue count, revision recommendation count, unresolved blocker count, reviewed paragraph count, reviewed claim count, diagnostics, and safety notice. If `red-team-report-status` reports blocked, partial, failed, stale, or unresolved prerequisites, status preserves that blocker instead of treating a stale primary report as completed critique. Older runs without a red-team stage return `redTeamReport.status: "not-run"` while preserving earlier summaries.

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

After research memo generation runs, the research memo task receives `research-memo`. When generation is blocked, partial, or failed, Fusion also writes `research-memo-status`. The evidence-ledger stage reads `research-memo` and treats `research-memo-status` blockers as unresolved prerequisites, not support.

After evidence ledger generation runs, the evidence-ledger task receives `evidence-ledger`. When generation is blocked, partial, failed, or stale because of `research-memo-status`, Fusion also writes `evidence-ledger-status`. The claim-map stage reads `evidence-ledger` when it exists and treats `evidence-ledger-status` blockers as unresolved prerequisites, not support.

After claim-map generation runs, the claim-map task receives `claim-map`. When generation is blocked, partial, failed, or stale because of `evidence-ledger-status`, Fusion also writes `claim-map-status`. Complaint-drafting and later stages read `claim-map` when it exists and treat `claim-map-status` blockers as unresolved prerequisites, not support.

After draft complaint generation runs, the draft-complaint task receives `draft-counter-lawsuit-complaint`. Fusion always rewrites this primary document when generation is attempted, even when blocked, so stale complaint text cannot be mistaken for current support. When generation is blocked, partial, failed, or stale because of `claim-map-status`, Fusion also writes `draft-counter-lawsuit-complaint-status`. FN-015 opposing-counsel red-team work should use these documents as its prerequisite input and treat any status blockers, missing-proof entries, red-team-pending marker, unresolved authorities, missing source paths, or human verification requirements as unresolved drafting risk, not as support.

After red-team report generation runs, the red-team stage task receives `red-team-report`. Fusion always rewrites this primary document when generation is attempted, even when blocked, so stale red-team critique cannot be mistaken for current support. When generation is blocked, partial, failed, or stale because of `draft-counter-lawsuit-complaint-status` or `claim-map-status`, Fusion also writes `red-team-report-status`. FN-010 lineage/scoring work should read both documents, preserve unsupported findings, unlinked MTD risk rows, citation issue rows, revision recommendations, unresolved blockers, and status limitations, and avoid treating the report as reliable, filing-ready, promoted, or attorney verified.

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

## Research memo document schema

The `research-memo` document contains a human-readable draft memo plus this machine-readable JSON manifest:

```ts
{
  runId: string;
  generatedAt: string;
  status: "completed" | "partial" | "blocked" | "failed";
  sourceDocuments: Array<{ taskId: string; key: string; present: boolean; parsedFrom?: string; status?: string }>;
  searches: Array<{ query: string; sourceSystem?: string; providerName?: string; toolName?: string; receiptIds: string[] }>;
  evidence: Array<{
    receiptId: string;
    sourcePath: string;
    sourceSystem: string;
    providerName?: string;
    toolName?: string;
    query?: string;
    title?: string;
    excerpt?: string;
    retrievedAt?: string;
    hash?: string;
    verified: false;
  }>;
  authorities: Array<{
    recordId: string;
    input: string;
    inputType?: string;
    status: "matched" | "not-found" | "ambiguous" | "unavailable" | string;
    normalizedCitation?: string;
    caseName?: string;
    courtListenerUrl?: string;
    absoluteUrl?: string;
    legalConclusionVerified: false;
    promoted: false;
  }>;
  conclusions: Array<{
    conclusionId: string;
    text: string;
    supportReceiptIds: string[];
    supportAuthorityRecordIds: string[];
    unresolvedGap: boolean;
  }>;
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  safetyNotice: string;
}
```

Every evidence item must have a `receiptId` and `sourcePath`. Every authority item must have a `recordId` and match `status`. Every draft conclusion either cites supporting receipt IDs or authority record IDs, or is explicitly labeled as an unresolved gap. Missing vault receipts, missing source paths, unmatched authorities, ambiguous authorities, unavailable providers, and malformed manifests appear as diagnostics or status entries.

The `research-memo-status` document records blocked, partial, failed, or stale-blocker state with the same safe counts, diagnostics, document keys, and safety notice. Missing vault receipts are blocked; they are never treated as a completed memo.

The memo is draft-only and source-linked only. It is not legal advice, not good-law verification, not citation-format validation, not filing-ready, not human verified, and not promoted for filing. It does not create the evidence ledger, claim map, complaint draft, opposing-counsel red-team report, lineage/scoring log, legal advice, filing-ready conclusions, or promoted authorities.

Raw MCP payloads, full note bodies, CourtListener raw payloads, authorization headers, API tokens, token-like provider errors, and unbounded provider errors are not persisted in the memo, memo status, metadata, or API responses.

## Evidence ledger document schema

The `evidence-ledger` document contains a human-readable structured ledger plus this machine-readable JSON manifest:

```ts
{
  runId: string;
  generatedAt: string;
  status: "completed" | "partial" | "blocked" | "failed";
  sourceDocuments: Array<{ taskId: string; key: "research-memo" | "research-memo-status"; present: boolean; parsedFrom?: string; status?: string }>;
  researchMemoTaskId: string;
  evidenceLedgerTaskId: string;
  facts: Array<{
    factId: string;
    factText: string;                   // bounded and secret-redacted
    sourceLinks: Array<{ sourceLinkId: string; receiptId: string; sourcePath: string; sourceSystem?: string; providerName?: string; toolName?: string }>;
    claimLinks: Array<{ claimLinkId: string; conclusionId?: string; status: "upstream-research-memo-conclusion" | "unresolved-placeholder"; createsClaimMap: false }>;
    authorityRecordIds: string[];
    confidence: "high" | "medium" | "low" | "unsupported";
    citationStatus: Array<{ status: "source-linked-local-evidence" | "matched-courtlistener-lookup-record" | "unresolved-authority-lookup-record" | "missing-source-link" | "needs-human-citation-verification"; unresolved: boolean; support: false }>;
    unresolvedGap: boolean;
    diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
    verified: false;
  }>;
  sourceLinks: unknown[];
  claimLinks: unknown[];
  citationStatuses: unknown[];
  confidenceRubric: Record<string, string>;
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  counts: { facts: number; sourceLinks: number; claimLinks: number; unresolvedGaps: number; citationStatuses: Record<string, number>; confidence: Record<string, number> };
  safetyNotice: string;
}
```

Facts are built only from safe research memo manifest fields: `evidence`, `authorities`, `conclusions`, `sourceDocuments`, `diagnostics`, and `safetyNotice`. The ledger preserves receipt IDs, source paths, preliminary links to upstream memo `conclusionId`s or explicit unresolved placeholders, authority record IDs, conservative confidence, citation status, unresolved gaps, and `verified: false`.

The `evidence-ledger-status` document records blocked, partial, failed, or stale-blocker state with the same safe counts, diagnostics, document keys, and safety notice. Missing research memo output, malformed manifests, blocked `research-memo-status`, missing source paths, unmatched or ambiguous authorities, unavailable providers, and unsupported facts remain visible as diagnostics or unresolved citation-status entries.

The ledger is draft-only and source-linked only. It is not legal advice, not verified fact support, not good-law verification, not citation-format validation, not filing-ready, not human verified, and not promoted for filing. It does not create the claim map, complaint draft, red-team report, lineage/scoring log, legal advice, citation validation, good-law verification, or filing-ready conclusions.

Raw MCP payloads, full note bodies, CourtListener raw payloads, authorization headers, API tokens, token-like provider errors, and unbounded source text are not persisted in the ledger, ledger status, metadata, or API responses.

## Claim map document schema

The `claim-map` document contains a human-readable structured claim map plus this machine-readable JSON manifest:

```ts
{
  runId: string;
  generatedAt: string;
  status: "completed" | "partial" | "blocked" | "failed";
  sourceDocuments: Array<{ taskId: string; key: "research-memo" | "evidence-ledger" | "evidence-ledger-status"; present: boolean; parsedFrom?: string; status?: string }>;
  researchMemoTaskId?: string;
  evidenceLedgerTaskId: string;
  claimMapTaskId: string;
  claims: Array<{ claimId: string; conclusionId?: string; label: string; status: "supported-draft" | "partial-draft" | "missing-proof" | "blocked"; elementIds: string[]; allegationIds: string[]; supportingEvidenceIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; missingProofIds: string[]; unresolvedDraftOnly: boolean; verified: false }>;
  elements: Array<{ elementId: string; claimId: string; label: string; status: "supported-draft" | "partial-draft" | "missing-proof" | "blocked"; allegationIds: string[]; supportingEvidenceIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; missingProofIds: string[]; invented: false; verified: false }>;
  allegations: Array<{ allegationId: string; claimId: string; elementId: string; factId: string; allegationText: string; supportingEvidenceIds: string[]; sourceLinkIds: string[]; receiptIds: string[]; sourcePaths: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; upstreamConfidence: "high" | "medium" | "low" | "unsupported"; verified: false; unresolvedDraftOnly: boolean }>;
  supportingEvidence: Array<{ supportingEvidenceId: string; claimId: string; elementId: string; allegationId: string; factId: string; sourceLinkId: string; receiptId: string; sourcePath: string; citationStatusIds: string[]; verified: false }>;
  missingProof: Array<{ missingProofId: string; scope: string; severity: "info" | "warning" | "error"; reason: string; claimId?: string; elementId?: string; allegationId?: string; factId?: string; unresolved: true }>;
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  counts: { claims: number; elements: number; allegations: number; supportingEvidence: number; missingProof: number; unresolvedGaps: number };
  safetyNotice: string;
}
```

Claim-map rows are built only from safe evidence ledger fields: `facts`, `sourceLinks`, `claimLinks`, `citationStatuses`, `confidenceRubric`, `diagnostics`, `sourceDocuments`, and `safetyNotice`. Safe research memo conclusion IDs and text may be used only as labels. Legal elements are never invented: absent upstream element metadata creates a “Legal element pending authority-backed extraction” placeholder and missing-proof rows.

The `claim-map-status` document records blocked, partial, failed, or stale-blocker state with safe counts, diagnostics, document keys, missing-proof counts, and the safety notice. Missing evidence ledgers, malformed manifests, blocked `evidence-ledger-status`, missing source paths, unsupported facts, unresolved authorities, missing legal elements, and human citation/source verification requirements remain visible as diagnostics or missing-proof entries.

The claim map is draft-only and source-linked only. It is not legal advice, not verified fact support, not good-law verification, not citation-format validation, not filing-ready, not human verified, and not promoted for filing. It does not create the complaint draft, red-team report, lineage/scoring log, legal advice, citation validation, good-law verification, or filing-ready conclusions.

Raw MCP payloads, full note bodies, CourtListener raw payloads, authorization headers, API tokens, token-like provider errors, and unbounded source text are not persisted in the claim map, claim-map status, metadata, or API responses.

## Draft complaint document schema

The `draft-counter-lawsuit-complaint` task document contains Markdown for review plus a safe JSON manifest. The Markdown is a pleading scaffold only. It uses deterministic sections, numbered paragraphs, claim-draft rows, source-reference rows, missing-proof rows, filing blockers, diagnostics, and the safety notice.

The safe manifest uses this shape:

```ts
{
  runId: string;
  status: "completed" | "partial" | "blocked" | "failed";
  generatedAt: string;
  sourceDocuments: Array<{ documentKey: "claim-map" | "claim-map-status"; taskId?: string; status?: string }>;
  claimMapTaskId?: string;
  draftComplaintTaskId: string;
  draftComplaintDocumentKey: "draft-counter-lawsuit-complaint";
  statusDocumentKey?: "draft-counter-lawsuit-complaint-status";
  sections: Array<{ sectionId: string; title: string; status: "draft" | "placeholder" | "blocked"; paragraphIds: string[]; unresolvedDraftOnly: boolean }>;
  paragraphs: Array<{ paragraphId: string; paragraphNumber: number; text: string; claimId?: string; elementId?: string; allegationId?: string; factId?: string; sourcePaths: string[]; receiptIds: string[]; supportingEvidenceIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; verified: false; filingReady: false; unresolvedDraftOnly: boolean }>;
  claimDrafts: Array<{ claimDraftId: string; claimId: string; label: string; elementIds: string[]; paragraphIds: string[]; supportingEvidenceIds: string[]; sourcePaths: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; missingProofIds: string[]; verified: false; filingReady: false; unresolvedDraftOnly: boolean }>;
  sourceReferences: Array<{ sourceReferenceId: string; sourcePath: string; receiptIds: string[]; claimIds: string[]; paragraphIds: string[]; citationStatusIds: string[]; verified: false }>;
  missingProof: Array<{ missingProofId: string; scope: string; severity: "info" | "warning" | "error"; reason: string; claimId?: string; elementId?: string; allegationId?: string; factId?: string; unresolved: true }>;
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; claimId?: string; elementId?: string; allegationId?: string; paragraphId?: string }>;
  counts: { sections: number; paragraphs: number; claimDrafts: number; sourceReferences: number; sourcePaths: number; missingProof: number; unresolvedGaps: number };
  safetyNotice: string;
}
```

Complaint sections are generated from the claim map and never from request-body facts. Placeholder sections for parties, jurisdiction, venue, damages, and relief remain explicitly unresolved unless an upstream claim-map row provides source-linked support.

Missing claim maps, blocked `claim-map-status`, malformed manifests, missing source paths, unsupported allegations, unresolved authorities, missing legal elements, red-team-pending state, and human citation/source verification requirements remain visible as diagnostics, missing-proof entries, filing blockers, or status entries.

The `draft-counter-lawsuit-complaint-status` document records blocked, partial, failed, or stale-blocker state with the same safe counts, diagnostics, document keys, filing blockers, missing-proof counts, and safety notice. A stale or malformed primary draft is not treated as completed.

The complaint draft is draft-only and source-linked only. It is not legal advice, not verified fact support, not good-law verification, not citation-format validation, not filing-ready, not human verified, and not promoted for filing. Launch then attempts the separate opposing-counsel red-team report from persisted documents only, but the complaint draft itself does not create the lineage/scoring log, final citation validation, good-law verification, attorney review, or filing workflow.

Raw MCP payloads, full note bodies, CourtListener raw payloads, authorization headers, API tokens, token-like provider errors, and unbounded source text are not persisted in the complaint draft, complaint status, metadata, or API responses.

The red-team stage starts from the canonical `draft-counter-lawsuit-complaint` document key and its companion status document, then produces the opposing-counsel red-team report as a separate downstream artifact.

## Red-team report document schema

The `red-team-report` task document contains Markdown for adversarial review plus a safe JSON manifest. The Markdown is an opposing-counsel critique only. It covers pleading weaknesses, candidate motion-to-dismiss risk categories, citation/source issue rows, paragraph and claim critique, revision recommendations, unresolved blockers, diagnostics, and the safety notice.

The safe manifest uses this shape:

```ts
{
  runId: string;
  status: "completed" | "partial" | "blocked" | "failed" | "stale";
  generatedAt: string;
  sourceDocuments: Array<{ taskId: string; key: "claim-map" | "claim-map-status" | "draft-counter-lawsuit-complaint" | "draft-counter-lawsuit-complaint-status"; present: boolean; parsedFrom?: "metadata" | "json-block" | "missing" | "malformed"; status?: string }>;
  claimMapTaskId?: string;
  draftComplaintTaskId?: string;
  redTeamTaskId?: string;
  redTeamReportDocumentKey: "red-team-report";
  statusDocumentKey?: "red-team-report-status";
  findings: Array<{ findingId: string; category: string; severity: "info" | "warning" | "high" | "blocker"; summary: string; paragraphIds: string[]; claimDraftIds: string[]; missingProofIds: string[]; sourceReferenceIds: string[]; sourcePaths: string[]; receiptIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; sourceTaskIds: string[]; unresolved: true }>;
  mtdAttacks: Array<{ attackId: string; category: string; severity: "info" | "warning" | "high" | "blocker"; summary: string; paragraphIds: string[]; claimDraftIds: string[]; missingProofIds: string[]; sourceReferenceIds: string[]; sourcePaths: string[]; receiptIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; sourceTaskIds: string[]; draftRiskOnly: true }>;
  citationIssues: Array<{ issueId: string; severity: "info" | "warning" | "high" | "blocker"; summary: string; paragraphIds: string[]; claimDraftIds: string[]; sourceReferenceIds: string[]; sourcePaths: string[]; receiptIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; humanVerificationRequired: true }>;
  revisionRecommendations: Array<{ recommendationId: string; findingIds: string[]; summary: string; paragraphIds: string[]; claimDraftIds: string[]; missingProofIds: string[]; sourceReferenceIds: string[]; sourcePaths: string[]; receiptIds: string[]; authorityRecordIds: string[]; citationStatusIds: string[]; sourceTaskIds: string[]; unresolved: true }>;
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; paragraphId?: string; claimDraftId?: string; findingId?: string }>;
  counts: { findings: number; mtdAttacks: number; citationIssues: number; revisionRecommendations: number; unresolvedBlockers: number; reviewedParagraphs: number; reviewedClaims: number; sourceReferences: number; sourcePaths: number };
  safetyNotice: string;
}
```

Red-team rows are generated from the complaint draft and claim-map documents, never from request-body legal theories or arguments. Candidate MTD attacks are draft risk categories only; they are not final motion practice decisions, defenses, legal advice, or attorney-reviewed arguments.

Missing complaint drafts, blocked or stale `draft-counter-lawsuit-complaint-status`, malformed manifests, missing source paths, unsupported allegations, unresolved authorities, placeholder jurisdiction/venue/standing/relief/damages, and human citation/source verification needs remain visible as findings, citation issues, revision recommendations, diagnostics, blockers, or status entries.

The `red-team-report-status` document records blocked, partial, failed, or stale-blocker state with the same safe counts, diagnostics, document keys, unresolved blocker counts, and safety notice. A stale or malformed primary report is not treated as completed critique. Its metadata and embedded JSON use this bounded status shape:

```ts
{
  runId: string;
  status: "completed" | "partial" | "blocked" | "failed" | "stale";
  redTeamReportDocumentKey: "red-team-report";
  statusDocumentKey: "red-team-report-status";
  findingCount: number;
  mtdAttackCount: number;
  citationIssueCount: number;
  revisionRecommendationCount: number;
  unresolvedBlockerCount: number;
  reviewedParagraphCount: number;
  reviewedClaimCount: number;
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; sourceDocumentKey?: string; sourceTaskId?: string; paragraphId?: string; claimDraftId?: string; findingId?: string }>;
  safetyNotice: string;
}
```

The red-team report is draft-only and source-linked only. It is not legal advice, not verified fact support, not good-law verification, not citation-format validation, not filing-ready, not human verified, not promoted for filing, and not reliable support. It creates an opposing-counsel red-team report only; it does not create the lineage/scoring log, final citation validation, good-law verification, attorney review, real motion practice decisions, filing workflow, filing-ready pleading, or blocker resolution.

Raw MCP payloads, full note bodies, CourtListener raw payloads, authorization headers, API tokens, token-like provider errors, and unbounded source text are not persisted in the red-team report, report status, metadata, or API responses.

FN-010 is the downstream handoff for lineage/scoring. It should read `red-team-report` and `red-team-report-status`, preserve unresolved blockers and limitations, and must not treat any red-team finding, MTD row, citation issue, or recommendation as reliable support, filing readiness, human verification, or promoted output.

## Agents and Codex legal skills

The server creates or reuses durable legal workflow agents. It does not create ephemeral runtime agents for this workflow.

Agents are keyed by workflow role and Codex skill set, and `metadata.skills` stores the resolved skill names. Assigned stage tasks set `assignedAgentId`, so runtime skill selection can use the durable agent metadata.

## Safety workflow steps

Every generated stage task enables three prompt-mode pre-merge workflow steps:

- Citation/source verification
- Opposing-counsel red-team review
- Lineage preservation

The citation/source prompt checks `research-memo` for source-linked evidence, matched authorities when used as support, unresolved gaps, and lineage. It checks `research-memo-status` for unresolved blockers. It checks `evidence-ledger` for source-linked fact rows, preliminary claim links, confidence labels, citation status, unresolved gaps, and absence of positive promotion or filing-ready claims. It checks `evidence-ledger-status` for blocked, partial, failed, stale, or unresolved prerequisites. It checks `claim-map` for claim groups, element rows, allegation-to-evidence links, missing-proof entries, unresolved authority gaps, and absence of positive promotion or filing-ready claims. It checks `claim-map-status` for blocked, partial, failed, stale, or unresolved prerequisites. It checks `draft-counter-lawsuit-complaint` for draft complaint paragraphs, source references, missing-proof blockers, unresolved authorities, red-team-pending labels, and absence of promoted or filing-ready language. It checks `draft-counter-lawsuit-complaint-status` for blocked, partial, failed, stale, or unresolved prerequisites. It checks `red-team-report` for unsupported findings, unlinked candidate MTD attack rows, citation issue rows, revision recommendations, unresolved blockers, and absence of promoted, reliable, or filing-ready language. It checks `red-team-report-status` for blocked, partial, failed, stale, or unresolved prerequisites. It also checks `courtlistener-authority-validation` when legal authorities are cited and the document exists.

It requires `REQUEST REVISION` when an authority is used as support without a matched CourtListener record, or when missing, unmatched, ambiguous, or unavailable CourtListener results are presented as support. It also requires revision when draft complaint paragraphs, source references, missing-proof blockers, unresolved authorities, red-team-pending labels, unsupported red-team findings, unlinked MTD attack rows, citation issue rows, revision recommendations, or red-team blockers are omitted from the safety review. Explicitly labeled unverified authority notes may remain only as unresolved research gaps; they do not satisfy the completion gate as support.

The opposing-counsel red-team prompt requires `red-team-report` to attack `draft-counter-lawsuit-complaint` before passing. It checks `draft-counter-lawsuit-complaint-status` and `red-team-report-status` for unresolved blockers, and it requires pleading weaknesses, candidate MTD attack rows, citation/source issue rows, unresolved blockers, placeholder pleading field risks, and conservative revision recommendations. It prevents downstream completion from treating the draft complaint or red-team report as promoted, reliable, verified, good-law checked, citation-format validated, human verified, legal advice, or filing-ready.

## Optional source scope behavior

A launch can omit source scope and source query.

When no `vaultScope`, `sourceScope`, or `sourceQuery` is supplied, the run records `sourceScopeStatus: "unspecified"`. Generated prompts tell agents to treat source discovery as unverified until QMD MCP or Obsidian MCP mining supplies receipts.

`focus` narrows the legal theory or question, but it is not treated as a verified source scope by itself.

## Integration boundaries

This workflow now mines QMD MCP and Obsidian MCP for source-linked local receipts, uses CourtListener for bounded authority lookup when candidates are available, generates a source-linked draft research memo from those persisted manifests, generates a structured evidence ledger from the persisted memo documents, generates a structured claim map from the persisted evidence ledger documents, generates a deterministic draft complaint scaffold from the persisted claim-map documents, and generates an opposing-counsel red-team report from persisted complaint and claim-map documents.

CourtListener can confirm that a citation or query maps to a CourtListener record or candidate match. It does not Shepardize, determine good-law status, verify legal conclusions, check final filing citation format, decide filing readiness, generate filings, or replace attorney judgment.

Stage prompts instruct agents to use integrations when available and to mark unavailable integration results as unverified. Outputs, mined receipts, authority-validation records, generated research memos, generated evidence ledgers, generated claim maps, generated complaint drafts, and generated red-team reports are drafts or source manifests only. They are source-linked only, not legal advice, not verified facts, not verified fact support, not good-law verification, not citation-format validation, not filing-ready, not human verification, not promoted for filing, and not reliable support. FN-010 remains the downstream handoff for lineage/scoring work.
