import type { Task, TaskDocument, TaskStore } from "@fusion/core";
import {
  COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
  COURTLISTENER_SAFETY_NOTICE,
  COURTLISTENER_STATUS_DOCUMENT_KEY,
  type CourtListenerProviderDiagnostic,
} from "./legal-courtlistener.js";
import {
  VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
  VAULT_MINING_SAFETY_NOTICE,
  VAULT_MINING_STATUS_DOCUMENT_KEY,
  type VaultMiningProviderDiagnostic,
} from "./legal-vault-mining.js";
import { COUNTER_LAWSUIT_WORKFLOW_KIND } from "./legal-workflow-orchestrator.js";
import { notFound } from "./api-error.js";

export const RESEARCH_MEMO_DOCUMENT_KEY = "research-memo";
export const RESEARCH_MEMO_STATUS_DOCUMENT_KEY = "research-memo-status";
export const RESEARCH_MEMO_SAFETY_NOTICE = "Draft-only legal research memo generated from persisted source manifests. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.";

export type ResearchMemoStatus = "completed" | "partial" | "blocked" | "failed" | "not-run";
export type ResearchMemoDiagnosticSeverity = "info" | "warning" | "error";

export interface ResearchMemoDiagnostic {
  code: string;
  severity: ResearchMemoDiagnosticSeverity;
  message: string;
  sourceDocumentKey?: string;
  sourceTaskId?: string;
}

export interface ResearchMemoSearchEntry {
  query: string;
  sourceSystem?: string;
  providerName?: string;
  toolName?: string;
  receiptIds: string[];
}

export interface ResearchMemoEvidenceItem {
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
}

export interface ResearchMemoAuthorityItem {
  recordId: string;
  input: string;
  inputType?: string;
  status: string;
  normalizedCitation?: string;
  caseName?: string;
  court?: string;
  dateFiled?: string;
  clusterId?: string;
  opinionId?: string;
  courtListenerUrl?: string;
  absoluteUrl?: string;
  retrievedAt?: string;
  hash?: string;
  legalConclusionVerified: false;
  promoted: false;
}

export interface ResearchMemoConclusion {
  conclusionId: string;
  text: string;
  supportReceiptIds: string[];
  supportAuthorityRecordIds: string[];
  unresolvedGap: boolean;
}

export interface ResearchMemoSourceDocumentSummary {
  taskId: string;
  key: string;
  present: boolean;
  parsedFrom?: "metadata" | "json-block" | "missing" | "malformed";
  status?: string;
}

export interface CounterLawsuitResearchMemoResult {
  runId: string;
  status: ResearchMemoStatus;
  generatedAt: string;
  taskId?: string;
  matterName?: string;
  memoDocumentKey: typeof RESEARCH_MEMO_DOCUMENT_KEY;
  statusDocumentKey?: typeof RESEARCH_MEMO_STATUS_DOCUMENT_KEY;
  sourceDocuments: ResearchMemoSourceDocumentSummary[];
  searches: ResearchMemoSearchEntry[];
  evidence: ResearchMemoEvidenceItem[];
  authorities: ResearchMemoAuthorityItem[];
  conclusions: ResearchMemoConclusion[];
  diagnostics: ResearchMemoDiagnostic[];
  evidenceCount: number;
  authorityCount: number;
  conclusionCount: number;
  sourcePathCount: number;
  safetyNotice: typeof RESEARCH_MEMO_SAFETY_NOTICE;
}

export interface CounterLawsuitResearchMemoSummary {
  runId: string;
  status: ResearchMemoStatus;
  memoDocumentKey?: typeof RESEARCH_MEMO_DOCUMENT_KEY | string;
  statusDocumentKey?: typeof RESEARCH_MEMO_STATUS_DOCUMENT_KEY | string;
  evidenceCount: number;
  authorityCount: number;
  conclusionCount: number;
  sourcePathCount: number;
  diagnostics: ResearchMemoDiagnostic[];
  safetyNotice: typeof RESEARCH_MEMO_SAFETY_NOTICE;
}

export interface GenerateCounterLawsuitResearchMemoOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument" | "upsertTaskDocument">;
  runId: string;
  force?: boolean;
  now?: () => Date;
}

export interface CollectCounterLawsuitResearchMemoInputsOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
  now?: () => Date;
}

interface ParsedDocument {
  document: TaskDocument | null;
  source: ResearchMemoSourceDocumentSummary["parsedFrom"];
  manifest?: Record<string, unknown>;
  diagnostics: ResearchMemoDiagnostic[];
}

const MAX_TEXT_CHARS = 900;
const MAX_CONCLUSION_CHARS = 700;
const MAX_DIAGNOSTICS = 25;
const TOKEN_RE = /["']?(?:authorization)["']?\s*[:=]\s*["']?(?:bearer|token)\s+[^"'\s,}]{8,}["']?|["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|Token\s+\S{8,}|(?:sk|pk|ghp|github_pat|obsidian)[A-Za-z0-9_:\-.=+/]{8,}/gi;
const SECRET_FLAG_VALUE_RE = /(--[A-Za-z0-9_.-]*(?:token|secret|key|password|credential|auth)[A-Za-z0-9_.-]*)(\s+)(?:"[^"]+"|'[^']+'|\S+)/gi;

function redactSecrets(value: string): string {
  return value
    .replace(SECRET_FLAG_VALUE_RE, "$1$2[REDACTED]")
    .replace(TOKEN_RE, "[REDACTED]");
}

function boundedText(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function boundedArray<T>(values: T[], limit = 100): T[] {
  return values.slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pickString(record: Record<string, unknown>, keys: string[], maxChars = MAX_TEXT_CHARS): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const bounded = boundedText(String(value), maxChars);
      if (bounded) return bounded;
    }
  }
  return undefined;
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function findResearchMemoTask(tasks: Task[]): Task | undefined {
  return tasks.find((task) => task.sourceMetadata?.workflowStage === "research-memo")
    ?? tasks.find((task) => task.sourceMetadata?.documentKey === RESEARCH_MEMO_DOCUMENT_KEY);
}

export async function locateCounterLawsuitResearchMemoStageTask(params: {
  taskStore: Pick<TaskStore, "listTasks">;
  runId: string;
}): Promise<{ tasks: Task[]; researchMemoTask: Task }> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId))
    .sort((left, right) => Number(left.sourceMetadata?.workflowStageIndex ?? 0) - Number(right.sourceMetadata?.workflowStageIndex ?? 0));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  const researchMemoTask = findResearchMemoTask(tasks);
  if (!researchMemoTask) throw notFound(`Legal workflow run ${params.runId} has no research-memo stage task`);
  return { tasks, researchMemoTask };
}

function parseJsonBlock(content: string): Record<string, unknown> | undefined {
  const match = content.match(/```json\s*([\s\S]*?)```/);
  if (!match) return undefined;
  try {
    return asRecord(JSON.parse(match[1]) as unknown);
  } catch {
    return undefined;
  }
}

function parseManifestFromDocument(document: TaskDocument | null, key: string): ParsedDocument {
  if (!document) {
    return {
      document,
      source: "missing",
      diagnostics: [{ code: "missing-document", severity: "warning", message: `Missing prerequisite document ${key}.`, sourceDocumentKey: key }],
    };
  }

  const metadata = asRecord(document.metadata);
  if (metadata && Object.keys(metadata).length > 0) {
    return {
      document,
      source: "metadata",
      manifest: metadata,
      diagnostics: [],
    };
  }

  const jsonManifest = parseJsonBlock(document.content);
  if (jsonManifest) {
    return { document, source: "json-block", manifest: jsonManifest, diagnostics: [] };
  }

  return {
    document,
    source: "malformed",
    diagnostics: [{ code: "malformed-manifest", severity: "warning", message: `Document ${key} did not contain metadata or a valid JSON manifest.`, sourceDocumentKey: key, sourceTaskId: document.taskId }],
  };
}

async function readParsedDocument(
  taskStore: Pick<TaskStore, "getTaskDocument">,
  taskId: string,
  key: string,
): Promise<ParsedDocument> {
  const document = await taskStore.getTaskDocument(taskId, key).catch(() => null);
  return parseManifestFromDocument(document, key);
}

function manifestArray(manifest: Record<string, unknown> | undefined, keys: string[]): Array<Record<string, unknown>> {
  if (!manifest) return [];
  for (const key of keys) {
    const value = manifest[key];
    if (Array.isArray(value)) return value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record));
  }
  return [];
}

function normalizeEvidence(records: Array<Record<string, unknown>>, diagnostics: ResearchMemoDiagnostic[]): ResearchMemoEvidenceItem[] {
  const seen = new Set<string>();
  const evidence: ResearchMemoEvidenceItem[] = [];
  for (const record of records) {
    const receiptId = pickString(record, ["receiptId", "id"], 180);
    const sourcePath = pickString(record, ["sourcePath", "source_path", "path", "reference"], 500);
    if (!receiptId || !sourcePath) {
      diagnostics.push({
        code: "invalid-evidence-receipt",
        severity: "error",
        message: "Vault receipt is missing a receipt ID or source path and cannot support the memo.",
        sourceDocumentKey: VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
      });
      continue;
    }
    if (seen.has(receiptId)) continue;
    seen.add(receiptId);
    evidence.push({
      receiptId,
      sourcePath,
      sourceSystem: pickString(record, ["sourceSystem"], 120) ?? "unknown",
      providerName: pickString(record, ["providerName"], 120),
      toolName: pickString(record, ["toolName"], 120),
      query: pickString(record, ["query"], 300),
      title: pickString(record, ["title"], 300),
      excerpt: pickString(record, ["excerpt", "summary"], MAX_TEXT_CHARS),
      retrievedAt: pickString(record, ["retrievedAt", "fetchedAt"], 80),
      hash: pickString(record, ["hash"], 180),
      verified: false,
    });
  }
  return evidence.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
}

function normalizeAuthorities(records: Array<Record<string, unknown>>, diagnostics: ResearchMemoDiagnostic[]): ResearchMemoAuthorityItem[] {
  const seen = new Set<string>();
  const authorities: ResearchMemoAuthorityItem[] = [];
  for (const record of records) {
    const recordId = pickString(record, ["recordId", "id"], 180);
    const status = pickString(record, ["status"], 80);
    if (!recordId || !status) {
      diagnostics.push({
        code: "invalid-authority-record",
        severity: "warning",
        message: "CourtListener authority record is missing an authority record ID or match status.",
        sourceDocumentKey: COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
      });
      continue;
    }
    if (seen.has(recordId)) continue;
    seen.add(recordId);
    authorities.push({
      recordId,
      input: pickString(record, ["input"], 300) ?? recordId,
      inputType: pickString(record, ["inputType"], 80),
      status,
      normalizedCitation: pickString(record, ["normalizedCitation"], 300),
      caseName: pickString(record, ["caseName"], 400),
      court: pickString(record, ["court"], 120),
      dateFiled: pickString(record, ["dateFiled"], 80),
      clusterId: pickString(record, ["clusterId"], 120),
      opinionId: pickString(record, ["opinionId"], 120),
      courtListenerUrl: pickString(record, ["courtListenerUrl"], 500),
      absoluteUrl: pickString(record, ["absoluteUrl"], 500),
      retrievedAt: pickString(record, ["retrievedAt"], 80),
      hash: pickString(record, ["hash"], 180),
      legalConclusionVerified: false,
      promoted: false,
    });
  }
  return authorities.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function normalizeSearches(evidence: ResearchMemoEvidenceItem[], manifest: Record<string, unknown> | undefined): ResearchMemoSearchEntry[] {
  const searches = new Map<string, ResearchMemoSearchEntry>();
  const rawQueries = Array.isArray(manifest?.queries) ? manifest.queries : [];
  for (const query of rawQueries) {
    const bounded = boundedText(query, 300);
    if (bounded && !searches.has(bounded)) searches.set(bounded, { query: bounded, receiptIds: [] });
  }
  for (const item of evidence) {
    const query = item.query ?? "unspecified query";
    const existing = searches.get(query) ?? { query, sourceSystem: item.sourceSystem, providerName: item.providerName, toolName: item.toolName, receiptIds: [] };
    existing.sourceSystem ??= item.sourceSystem;
    existing.providerName ??= item.providerName;
    existing.toolName ??= item.toolName;
    existing.receiptIds.push(item.receiptId);
    searches.set(query, existing);
  }
  return Array.from(searches.values())
    .map((entry) => ({ ...entry, receiptIds: Array.from(new Set(entry.receiptIds)).sort() }))
    .sort((left, right) => left.query.localeCompare(right.query));
}

function normalizeDiagnostics(...diagnosticGroups: Array<Array<ResearchMemoDiagnostic> | undefined>): ResearchMemoDiagnostic[] {
  const result: ResearchMemoDiagnostic[] = [];
  for (const group of diagnosticGroups) {
    for (const diagnostic of group ?? []) {
      result.push({ ...diagnostic, message: boundedText(diagnostic.message, 500) ?? diagnostic.code });
    }
  }
  return boundedArray(result, MAX_DIAGNOSTICS);
}

function upstreamDiagnostics(params: {
  vaultManifest?: Record<string, unknown>;
  vaultStatusManifest?: Record<string, unknown>;
  authorityManifest?: Record<string, unknown>;
  authorityStatusManifest?: Record<string, unknown>;
}): ResearchMemoDiagnostic[] {
  const diagnostics: ResearchMemoDiagnostic[] = [];
  const vaultProviders = manifestArray(params.vaultManifest, ["providerDiagnostics", "diagnostics"]) as unknown as VaultMiningProviderDiagnostic[];
  for (const provider of vaultProviders) {
    const status = typeof provider.status === "string" ? provider.status : "unknown";
    if (["error", "unavailable", "partial"].includes(status)) {
      diagnostics.push({ code: "vault-provider-status", severity: status === "partial" ? "warning" : "error", message: `${provider.providerName ?? "vault provider"}: ${provider.message ?? status}`, sourceDocumentKey: VAULT_MINING_RECEIPTS_DOCUMENT_KEY });
    }
  }
  const courtDiagnostics = manifestArray(params.authorityManifest, ["diagnostics", "providerDiagnostics"]) as unknown as CourtListenerProviderDiagnostic[];
  for (const diagnostic of courtDiagnostics) {
    const status = typeof diagnostic.status === "string" ? diagnostic.status : "unknown";
    if (["error", "unavailable", "partial", "skipped"].includes(status)) {
      diagnostics.push({ code: "courtlistener-provider-status", severity: status === "skipped" ? "info" : "warning", message: `${diagnostic.providerName ?? "courtlistener"}: ${diagnostic.message ?? status}`, sourceDocumentKey: COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY });
    }
  }
  for (const [key, manifest] of [[VAULT_MINING_STATUS_DOCUMENT_KEY, params.vaultStatusManifest], [COURTLISTENER_STATUS_DOCUMENT_KEY, params.authorityStatusManifest]] as const) {
    const status = typeof manifest?.status === "string" ? manifest.status : undefined;
    if (status && !["completed"].includes(status)) {
      diagnostics.push({ code: "upstream-status", severity: status === "no-candidates" ? "info" : "warning", message: `${key} reports status ${status}.`, sourceDocumentKey: key });
    }
  }
  return diagnostics;
}

function buildConclusions(params: {
  evidence: ResearchMemoEvidenceItem[];
  authorities: ResearchMemoAuthorityItem[];
  diagnostics: ResearchMemoDiagnostic[];
}): ResearchMemoConclusion[] {
  const conclusions: ResearchMemoConclusion[] = [];
  if (params.evidence.length > 0) {
    conclusions.push({
      conclusionId: "C-001",
      text: boundedText(`Source-linked evidence receipts are available for memo drafting. Support is limited to receipt IDs ${params.evidence.map((item) => item.receiptId).slice(0, 12).join(", ")}.`, MAX_CONCLUSION_CHARS) ?? "Source-linked evidence receipts are available.",
      supportReceiptIds: params.evidence.map((item) => item.receiptId),
      supportAuthorityRecordIds: [],
      unresolvedGap: false,
    });
  } else {
    conclusions.push({ conclusionId: "C-001", text: "Unresolved gap: no vault-mining receipts are available, so no factual conclusion can be drafted safely.", supportReceiptIds: [], supportAuthorityRecordIds: [], unresolvedGap: true });
  }

  const matchedAuthorities = params.authorities.filter((authority) => authority.status === "matched");
  if (matchedAuthorities.length > 0) {
    conclusions.push({
      conclusionId: "C-002",
      text: boundedText(`Matched CourtListener authority lookup records are available for possible legal research support. Support is limited to authority record IDs ${matchedAuthorities.map((item) => item.recordId).join(", ")}.`, MAX_CONCLUSION_CHARS) ?? "Matched CourtListener authority lookup records are available.",
      supportReceiptIds: [],
      supportAuthorityRecordIds: matchedAuthorities.map((item) => item.recordId),
      unresolvedGap: false,
    });
  }

  const unresolvedAuthorities = params.authorities.filter((authority) => authority.status !== "matched");
  if (unresolvedAuthorities.length > 0 || params.authorities.length === 0) {
    conclusions.push({
      conclusionId: `C-${String(conclusions.length + 1).padStart(3, "0")}`,
      text: unresolvedAuthorities.length > 0
        ? `Unresolved gap: ${unresolvedAuthorities.length} authority lookup record(s) are not matched and cannot be used as support.`
        : "Unresolved gap: no CourtListener authority validation records are available.",
      supportReceiptIds: [],
      supportAuthorityRecordIds: unresolvedAuthorities.map((item) => item.recordId),
      unresolvedGap: true,
    });
  }

  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    conclusions.push({
      conclusionId: `C-${String(conclusions.length + 1).padStart(3, "0")}`,
      text: "Unresolved gap: prerequisite diagnostics contain errors or missing source material, so the memo remains blocked or partial until corrected.",
      supportReceiptIds: [],
      supportAuthorityRecordIds: [],
      unresolvedGap: true,
    });
  }
  return conclusions;
}

function deriveStatus(params: {
  evidence: ResearchMemoEvidenceItem[];
  diagnostics: ResearchMemoDiagnostic[];
  vaultDocPresent: boolean;
}): ResearchMemoStatus {
  if (!params.vaultDocPresent || params.evidence.length === 0) return "blocked";
  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "partial";
  if (params.diagnostics.length > 0) return "partial";
  return "completed";
}

export async function collectCounterLawsuitResearchMemoInputs(options: CollectCounterLawsuitResearchMemoInputsOptions): Promise<CounterLawsuitResearchMemoResult> {
  const { researchMemoTask } = await locateCounterLawsuitResearchMemoStageTask({ taskStore: options.taskStore, runId: options.runId });
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const [vault, vaultStatus, authority, authorityStatus] = await Promise.all([
    readParsedDocument(options.taskStore, researchMemoTask.id, VAULT_MINING_RECEIPTS_DOCUMENT_KEY),
    readParsedDocument(options.taskStore, researchMemoTask.id, VAULT_MINING_STATUS_DOCUMENT_KEY),
    readParsedDocument(options.taskStore, researchMemoTask.id, COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY),
    readParsedDocument(options.taskStore, researchMemoTask.id, COURTLISTENER_STATUS_DOCUMENT_KEY),
  ]);

  const diagnostics: ResearchMemoDiagnostic[] = normalizeDiagnostics(
    vault.diagnostics,
    vaultStatus.diagnostics,
    authority.diagnostics,
    authorityStatus.diagnostics,
  );

  const evidenceDiagnostics: ResearchMemoDiagnostic[] = [];
  const authorityDiagnostics: ResearchMemoDiagnostic[] = [];
  const evidence = normalizeEvidence(manifestArray(vault.manifest, ["receipts", "evidence"]), evidenceDiagnostics);
  const authorities = normalizeAuthorities(manifestArray(authority.manifest, ["validationRecords", "authorities"]), authorityDiagnostics);
  const upstream = upstreamDiagnostics({
    vaultManifest: vault.manifest,
    vaultStatusManifest: vaultStatus.manifest,
    authorityManifest: authority.manifest,
    authorityStatusManifest: authorityStatus.manifest,
  });
  const allDiagnostics = normalizeDiagnostics(diagnostics, evidenceDiagnostics, authorityDiagnostics, upstream);
  const searches = normalizeSearches(evidence, vault.manifest);
  const conclusions = buildConclusions({ evidence, authorities, diagnostics: allDiagnostics });
  const sourceDocuments: ResearchMemoSourceDocumentSummary[] = [
    { taskId: researchMemoTask.id, key: VAULT_MINING_RECEIPTS_DOCUMENT_KEY, present: Boolean(vault.document), parsedFrom: vault.source },
    { taskId: researchMemoTask.id, key: VAULT_MINING_STATUS_DOCUMENT_KEY, present: Boolean(vaultStatus.document), parsedFrom: vaultStatus.source, status: typeof vaultStatus.manifest?.status === "string" ? vaultStatus.manifest.status : undefined },
    { taskId: researchMemoTask.id, key: COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY, present: Boolean(authority.document), parsedFrom: authority.source },
    { taskId: researchMemoTask.id, key: COURTLISTENER_STATUS_DOCUMENT_KEY, present: Boolean(authorityStatus.document), parsedFrom: authorityStatus.source, status: typeof authorityStatus.manifest?.status === "string" ? authorityStatus.manifest.status : undefined },
  ];
  const sourcePathCount = new Set(evidence.map((item) => item.sourcePath)).size;
  const status = deriveStatus({ evidence, diagnostics: allDiagnostics, vaultDocPresent: Boolean(vault.document) });

  return {
    runId: options.runId,
    status,
    generatedAt,
    taskId: researchMemoTask.id,
    matterName: typeof researchMemoTask.sourceMetadata?.matterName === "string" ? researchMemoTask.sourceMetadata.matterName : undefined,
    memoDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
    statusDocumentKey: status === "completed" ? undefined : RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
    sourceDocuments,
    searches,
    evidence,
    authorities,
    conclusions,
    diagnostics: allDiagnostics,
    evidenceCount: evidence.length,
    authorityCount: authorities.length,
    conclusionCount: conclusions.length,
    sourcePathCount,
    safetyNotice: RESEARCH_MEMO_SAFETY_NOTICE,
  };
}

export function researchMemoSummaryFromResult(result: CounterLawsuitResearchMemoResult): CounterLawsuitResearchMemoSummary {
  return {
    runId: result.runId,
    status: result.status,
    memoDocumentKey: result.memoDocumentKey,
    statusDocumentKey: result.statusDocumentKey,
    evidenceCount: result.evidenceCount,
    authorityCount: result.authorityCount,
    conclusionCount: result.conclusionCount,
    sourcePathCount: result.sourcePathCount,
    diagnostics: result.diagnostics,
    safetyNotice: result.safetyNotice,
  };
}

export function buildResearchMemoManifest(result: CounterLawsuitResearchMemoResult): Record<string, unknown> {
  return {
    runId: result.runId,
    generatedAt: result.generatedAt,
    status: result.status,
    sourceDocuments: result.sourceDocuments,
    searches: result.searches,
    evidence: result.evidence,
    authorities: result.authorities,
    conclusions: result.conclusions,
    diagnostics: result.diagnostics,
    safetyNotice: result.safetyNotice,
  };
}

function formatDiagnostics(diagnostics: ResearchMemoDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.sourceDocumentKey ? ` (${diagnostic.sourceDocumentKey})` : ""}: ${diagnostic.message}`).join("\n") || "- None.";
}

export function buildResearchMemoMarkdown(result: CounterLawsuitResearchMemoResult): string {
  const manifest = buildResearchMemoManifest(result);
  return `# Counter-lawsuit draft research memo

${RESEARCH_MEMO_SAFETY_NOTICE}

This memo also preserves upstream limits: ${VAULT_MINING_SAFETY_NOTICE} ${COURTLISTENER_SAFETY_NOTICE}

## Matter and run context

- Workflow run ID: ${result.runId}
- Research memo task ID: ${result.taskId ?? "unknown"}
- Matter name: ${result.matterName ?? "not recorded"}
- Generated at: ${result.generatedAt}
- Status: ${result.status}

## Searches performed

${result.searches.map((search) => `- ${search.query} — receipts: ${search.receiptIds.join(", ") || "none"}${search.providerName ? ` — provider: ${search.providerName}` : ""}${search.toolName ? ` — tool: ${search.toolName}` : ""}`).join("\n") || "- No persisted vault searches were available."}

## Evidence summary

${result.evidence.map((item) => `- ${item.receiptId} — ${item.sourcePath} — ${item.sourceSystem}${item.query ? ` — query: ${item.query}` : ""}${item.excerpt ? ` — excerpt: ${item.excerpt}` : ""}`).join("\n") || "- Unresolved gap: no source-linked vault receipts are available."}

## Authority summary

${result.authorities.map((item) => `- ${item.recordId} — ${item.status} — ${item.normalizedCitation ?? item.input}${item.courtListenerUrl ?? item.absoluteUrl ? ` — ${item.courtListenerUrl ?? item.absoluteUrl}` : ""}`).join("\n") || "- Unresolved gap: no CourtListener authority validation records are available."}

## Unresolved gaps

${result.conclusions.filter((conclusion) => conclusion.unresolvedGap).map((conclusion) => `- ${conclusion.conclusionId}: ${conclusion.text}${conclusion.supportAuthorityRecordIds.length > 0 ? ` Supporting unresolved authority record IDs: ${conclusion.supportAuthorityRecordIds.join(", ")}.` : ""}`).join("\n") || "- None recorded beyond draft-only safety limits."}

## Draft conclusions

${result.conclusions.map((conclusion) => `- ${conclusion.conclusionId}: ${conclusion.text} Support receipt IDs: ${conclusion.supportReceiptIds.join(", ") || "none"}. Support authority record IDs: ${conclusion.supportAuthorityRecordIds.join(", ") || "none"}. ${conclusion.unresolvedGap ? "This is an unresolved gap, not support." : ""}`).join("\n")}

## Diagnostics

${formatDiagnostics(result.diagnostics)}

## Source-path appendix

${result.evidence.map((item) => `- ${item.receiptId}: ${item.sourcePath}`).join("\n") || "- No source paths available."}

## Machine-readable manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

function statusDocumentInput(result: CounterLawsuitResearchMemoResult): { key: typeof RESEARCH_MEMO_STATUS_DOCUMENT_KEY; content: string; author: string; metadata: Record<string, unknown> } {
  return {
    key: RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
    content: `# Research memo status\n\nStatus: ${result.status}\n\n${RESEARCH_MEMO_SAFETY_NOTICE}\n\n## Diagnostics\n${formatDiagnostics(result.diagnostics)}\n`,
    author: "fusion-legal-research-memo",
    metadata: {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: result.runId,
      status: result.status,
      memoDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
      statusDocumentKey: RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
      evidenceCount: result.evidenceCount,
      authorityCount: result.authorityCount,
      conclusionCount: result.conclusionCount,
      sourcePathCount: result.sourcePathCount,
      diagnostics: result.diagnostics,
      safetyNotice: RESEARCH_MEMO_SAFETY_NOTICE,
    },
  };
}

export async function generateCounterLawsuitResearchMemo(options: GenerateCounterLawsuitResearchMemoOptions): Promise<CounterLawsuitResearchMemoResult> {
  const result = await collectCounterLawsuitResearchMemoInputs(options);
  try {
    await options.taskStore.upsertTaskDocument(result.taskId ?? "", {
      key: RESEARCH_MEMO_DOCUMENT_KEY,
      content: buildResearchMemoMarkdown(result),
      author: "fusion-legal-research-memo",
      metadata: buildResearchMemoManifest(result),
    });

    if (result.status !== "completed") {
      await options.taskStore.upsertTaskDocument(result.taskId ?? "", statusDocumentInput(result));
    } else {
      const staleStatus = await options.taskStore.getTaskDocument(result.taskId ?? "", RESEARCH_MEMO_STATUS_DOCUMENT_KEY).catch(() => null);
      if (staleStatus) {
        await options.taskStore.upsertTaskDocument(result.taskId ?? "", statusDocumentInput({ ...result, statusDocumentKey: RESEARCH_MEMO_STATUS_DOCUMENT_KEY }));
      }
    }

    return result;
  } catch (error) {
    const failedResult: CounterLawsuitResearchMemoResult = {
      ...result,
      status: "failed",
      statusDocumentKey: RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
      diagnostics: normalizeDiagnostics(result.diagnostics, [{
        code: "research-memo-generation-failed",
        severity: "error",
        message: `Research memo generation failed: ${error instanceof Error ? error.message : String(error)}`,
        sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
        sourceTaskId: result.taskId,
      }]),
    };
    await options.taskStore.upsertTaskDocument(failedResult.taskId ?? "", statusDocumentInput(failedResult));
    return failedResult;
  }
}

export async function deriveResearchMemoStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<CounterLawsuitResearchMemoSummary> {
  const { researchMemoTask } = await locateCounterLawsuitResearchMemoStageTask({ taskStore: params.taskStore, runId: params.runId });
  const doc = await params.taskStore.getTaskDocument(researchMemoTask.id, RESEARCH_MEMO_DOCUMENT_KEY).catch(() => null);
  const statusDoc = await params.taskStore.getTaskDocument(researchMemoTask.id, RESEARCH_MEMO_STATUS_DOCUMENT_KEY).catch(() => null);
  if (!doc) {
    const collected = await collectCounterLawsuitResearchMemoInputs(params);
    return { ...researchMemoSummaryFromResult(collected), memoDocumentKey: undefined, statusDocumentKey: statusDoc ? RESEARCH_MEMO_STATUS_DOCUMENT_KEY : collected.statusDocumentKey };
  }
  const manifest = parseManifestFromDocument(doc, RESEARCH_MEMO_DOCUMENT_KEY).manifest ?? {};
  const evidence = manifestArray(manifest, ["evidence"]);
  const authorities = manifestArray(manifest, ["authorities"]);
  const conclusions = manifestArray(manifest, ["conclusions"]);
  const diagnostics = manifestArray(manifest, ["diagnostics"]) as unknown as ResearchMemoDiagnostic[];
  const status = typeof statusDoc?.metadata?.status === "string" ? statusDoc.metadata.status as ResearchMemoStatus
    : typeof manifest.status === "string" ? manifest.status as ResearchMemoStatus
      : "completed";
  return {
    runId: params.runId,
    status,
    memoDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
    statusDocumentKey: statusDoc ? RESEARCH_MEMO_STATUS_DOCUMENT_KEY : undefined,
    evidenceCount: evidence.length,
    authorityCount: authorities.length,
    conclusionCount: conclusions.length,
    sourcePathCount: new Set(evidence.map((item) => typeof item.sourcePath === "string" ? item.sourcePath : undefined).filter(Boolean)).size,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    safetyNotice: RESEARCH_MEMO_SAFETY_NOTICE,
  };
}
