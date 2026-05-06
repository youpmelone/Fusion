import type { Task, TaskDocument, TaskStore } from "@fusion/core";
import { notFound } from "./api-error.js";
import {
  RESEARCH_MEMO_DOCUMENT_KEY,
  RESEARCH_MEMO_SAFETY_NOTICE,
  RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
  type ResearchMemoDiagnostic,
} from "./legal-research-memo.js";
import { COUNTER_LAWSUIT_WORKFLOW_KIND } from "./legal-workflow-orchestrator.js";

export const EVIDENCE_LEDGER_DOCUMENT_KEY = "evidence-ledger";
export const EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY = "evidence-ledger-status";
export const EVIDENCE_LEDGER_SAFETY_NOTICE = "Draft-only structured evidence ledger generated from the persisted research memo manifest. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.";

export type EvidenceLedgerStatus = "completed" | "partial" | "blocked" | "failed" | "not-run";
export type EvidenceLedgerDiagnosticSeverity = "info" | "warning" | "error";
export type EvidenceLedgerConfidence = "high" | "medium" | "low" | "unsupported";
export type EvidenceLedgerCitationStatusKind =
  | "source-linked-local-evidence"
  | "matched-courtlistener-lookup-record"
  | "unresolved-authority-lookup-record"
  | "missing-source-link"
  | "needs-human-citation-verification";

export interface EvidenceLedgerDiagnostic {
  code: string;
  severity: EvidenceLedgerDiagnosticSeverity;
  message: string;
  sourceDocumentKey?: string;
  sourceTaskId?: string;
  factId?: string;
}

export interface EvidenceLedgerSourceLink {
  sourceLinkId: string;
  receiptId: string;
  sourcePath: string;
  sourceSystem?: string;
  providerName?: string;
  toolName?: string;
  query?: string;
  title?: string;
  retrievedAt?: string;
  hash?: string;
}

export interface EvidenceLedgerClaimLink {
  claimLinkId: string;
  conclusionId?: string;
  factId: string;
  label: string;
  status: "upstream-research-memo-conclusion" | "unresolved-placeholder";
  createsClaimMap: false;
}

export interface EvidenceLedgerCitationStatus {
  citationStatusId: string;
  factId?: string;
  status: EvidenceLedgerCitationStatusKind;
  receiptId?: string;
  authorityRecordId?: string;
  message: string;
  unresolved: boolean;
  support: false;
}

export interface EvidenceLedgerFact {
  factId: string;
  factText: string;
  sourceLinks: EvidenceLedgerSourceLink[];
  claimLinks: EvidenceLedgerClaimLink[];
  authorityRecordIds: string[];
  confidence: EvidenceLedgerConfidence;
  citationStatus: EvidenceLedgerCitationStatus[];
  unresolvedGap: boolean;
  diagnostics: EvidenceLedgerDiagnostic[];
  verified: false;
}

export interface EvidenceLedgerSourceDocumentSummary {
  taskId: string;
  key: string;
  present: boolean;
  parsedFrom?: "metadata" | "json-block" | "missing" | "malformed";
  status?: string;
}

export interface EvidenceLedgerCounts {
  facts: number;
  sourceLinks: number;
  claimLinks: number;
  unresolvedGaps: number;
  citationStatuses: Record<EvidenceLedgerCitationStatusKind, number>;
  confidence: Record<EvidenceLedgerConfidence, number>;
}

export interface CounterLawsuitEvidenceLedgerResult {
  runId: string;
  status: EvidenceLedgerStatus;
  generatedAt: string;
  researchMemoTaskId?: string;
  evidenceLedgerTaskId?: string;
  ledgerDocumentKey: typeof EVIDENCE_LEDGER_DOCUMENT_KEY;
  statusDocumentKey?: typeof EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY;
  sourceDocuments: EvidenceLedgerSourceDocumentSummary[];
  facts: EvidenceLedgerFact[];
  sourceLinks: EvidenceLedgerSourceLink[];
  claimLinks: EvidenceLedgerClaimLink[];
  citationStatuses: EvidenceLedgerCitationStatus[];
  confidenceRubric: Record<EvidenceLedgerConfidence, string>;
  diagnostics: EvidenceLedgerDiagnostic[];
  counts: EvidenceLedgerCounts;
  safetyNotice: typeof EVIDENCE_LEDGER_SAFETY_NOTICE;
}

export interface CounterLawsuitEvidenceLedgerSummary {
  runId: string;
  status: EvidenceLedgerStatus;
  ledgerDocumentKey?: typeof EVIDENCE_LEDGER_DOCUMENT_KEY | string;
  statusDocumentKey?: typeof EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY | string;
  factCount: number;
  sourceLinkCount: number;
  claimLinkCount: number;
  unresolvedGapCount: number;
  citationStatusCounts: Record<EvidenceLedgerCitationStatusKind, number>;
  confidenceCounts: Record<EvidenceLedgerConfidence, number>;
  diagnostics: EvidenceLedgerDiagnostic[];
  safetyNotice: typeof EVIDENCE_LEDGER_SAFETY_NOTICE;
}

export interface GenerateCounterLawsuitEvidenceLedgerOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument" | "upsertTaskDocument">;
  runId: string;
  force?: boolean;
  now?: () => Date;
}

export interface CollectCounterLawsuitEvidenceLedgerInputsOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
  now?: () => Date;
}

interface ParsedDocument {
  document: TaskDocument | null;
  source: EvidenceLedgerSourceDocumentSummary["parsedFrom"];
  manifest?: Record<string, unknown>;
  diagnostics: EvidenceLedgerDiagnostic[];
}

interface ResearchMemoEvidenceManifestItem {
  receiptId: string;
  sourcePath: string;
  sourceSystem?: string;
  providerName?: string;
  toolName?: string;
  query?: string;
  title?: string;
  excerpt?: string;
  retrievedAt?: string;
  hash?: string;
}

interface ResearchMemoAuthorityManifestItem {
  recordId: string;
  input?: string;
  status: string;
  normalizedCitation?: string;
  caseName?: string;
  courtListenerUrl?: string;
  absoluteUrl?: string;
}

interface ResearchMemoConclusionManifestItem {
  conclusionId: string;
  text: string;
  supportReceiptIds: string[];
  supportAuthorityRecordIds: string[];
  unresolvedGap: boolean;
}

const MAX_TEXT_CHARS = 900;
const MAX_FACT_TEXT_CHARS = 700;
const MAX_DIAGNOSTICS = 40;
const AUTH_HEADER_RE = /(["']?(?:authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^"'\n\r,}]+/gi;
const TOKEN_RE = /["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|Token\s+\S{8,}|(?:sk|pk|ghp|github_pat|obsidian)[A-Za-z0-9_:\-.=+/]{8,}/gi;
const SECRET_FLAG_VALUE_RE = /(--[A-Za-z0-9_.-]*(?:token|secret|key|password|credential|auth)[A-Za-z0-9_.-]*)(\s+)(?:"[^"]+"|'[^']+'|\S+)/gi;

export const EVIDENCE_LEDGER_CONFIDENCE_RUBRIC: Record<EvidenceLedgerConfidence, string> = {
  high: "At least one bounded source path is linked, no fact-level error diagnostic is present, and no missing-source or unresolved-authority citation status is present. This is still not legal verification.",
  medium: "At least one bounded source path is linked, but authority lookup support is unresolved or needs human citation review.",
  low: "Some upstream context exists, but source paths are incomplete, diagnostics are present, or the row is an unresolved research gap.",
  unsupported: "No accepted source path supports the row, or the row only records a missing prerequisite or unresolved gap.",
};

const EMPTY_CITATION_COUNTS: Record<EvidenceLedgerCitationStatusKind, number> = {
  "source-linked-local-evidence": 0,
  "matched-courtlistener-lookup-record": 0,
  "unresolved-authority-lookup-record": 0,
  "missing-source-link": 0,
  "needs-human-citation-verification": 0,
};

const EMPTY_CONFIDENCE_COUNTS: Record<EvidenceLedgerConfidence, number> = {
  high: 0,
  medium: 0,
  low: 0,
  unsupported: 0,
};

function redactSecrets(value: string): string {
  return value
    .replace(AUTH_HEADER_RE, "$1[REDACTED]")
    .replace(SECRET_FLAG_VALUE_RE, "$1$2[REDACTED]")
    .replace(TOKEN_RE, "[REDACTED]");
}

function boundedText(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const compact = redactSecrets(String(value)).replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pickString(record: Record<string, unknown>, keys: string[], maxChars = MAX_TEXT_CHARS): string | undefined {
  for (const key of keys) {
    const bounded = boundedText(record[key], maxChars);
    if (bounded) return bounded;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => boundedText(item, 180)).filter((item): item is string => Boolean(item));
}

function manifestArray(manifest: Record<string, unknown> | undefined, keys: string[]): Array<Record<string, unknown>> {
  if (!manifest) return [];
  for (const key of keys) {
    const value = manifest[key];
    if (Array.isArray(value)) return value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record));
  }
  return [];
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function findStageTask(tasks: Task[], stage: string, documentKey: string): Task | undefined {
  return tasks.find((task) => task.sourceMetadata?.workflowStage === stage)
    ?? tasks.find((task) => task.sourceMetadata?.documentKey === documentKey);
}

export async function locateCounterLawsuitEvidenceLedgerStageTasks(params: {
  taskStore: Pick<TaskStore, "listTasks">;
  runId: string;
}): Promise<{ tasks: Task[]; researchMemoTask: Task; evidenceLedgerTask: Task }> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId))
    .sort((left, right) => Number(left.sourceMetadata?.workflowStageIndex ?? 0) - Number(right.sourceMetadata?.workflowStageIndex ?? 0));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  const researchMemoTask = findStageTask(tasks, "research-memo", RESEARCH_MEMO_DOCUMENT_KEY);
  if (!researchMemoTask) throw notFound(`Legal workflow run ${params.runId} has no research-memo stage task`);
  const evidenceLedgerTask = findStageTask(tasks, "evidence-ledger", EVIDENCE_LEDGER_DOCUMENT_KEY);
  if (!evidenceLedgerTask) throw notFound(`Legal workflow run ${params.runId} has no evidence-ledger stage task`);
  return { tasks, researchMemoTask, evidenceLedgerTask };
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
    return { document, source: "metadata", manifest: metadata, diagnostics: [] };
  }

  const jsonManifest = parseJsonBlock(document.content);
  if (jsonManifest) return { document, source: "json-block", manifest: jsonManifest, diagnostics: [] };

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

function normalizeDiagnostics(...diagnosticGroups: Array<Array<EvidenceLedgerDiagnostic | ResearchMemoDiagnostic> | undefined>): EvidenceLedgerDiagnostic[] {
  const result: EvidenceLedgerDiagnostic[] = [];
  for (const group of diagnosticGroups) {
    for (const diagnostic of group ?? []) {
      result.push({
        code: boundedText(diagnostic.code, 180) ?? "diagnostic",
        severity: diagnostic.severity === "error" || diagnostic.severity === "warning" || diagnostic.severity === "info" ? diagnostic.severity : "warning",
        message: boundedText(diagnostic.message, 500) ?? boundedText(diagnostic.code, 180) ?? "diagnostic",
        sourceDocumentKey: boundedText(diagnostic.sourceDocumentKey, 180),
        sourceTaskId: boundedText(diagnostic.sourceTaskId, 180),
        factId: "factId" in diagnostic ? boundedText(diagnostic.factId, 180) : undefined,
      });
    }
  }
  return result.slice(0, MAX_DIAGNOSTICS);
}

function normalizeMemoEvidence(records: Array<Record<string, unknown>>, diagnostics: EvidenceLedgerDiagnostic[]): ResearchMemoEvidenceManifestItem[] {
  const seen = new Set<string>();
  const evidence: ResearchMemoEvidenceManifestItem[] = [];
  for (const record of records) {
    const receiptId = pickString(record, ["receiptId", "id"], 180);
    const sourcePath = pickString(record, ["sourcePath", "source_path", "path", "reference"], 500);
    if (!receiptId || !sourcePath) {
      diagnostics.push({
        code: "invalid-ledger-source-link",
        severity: "error",
        message: "Research memo evidence is missing a receipt ID or source path and cannot support a ledger fact.",
        sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
      });
      continue;
    }
    if (seen.has(receiptId)) continue;
    seen.add(receiptId);
    evidence.push({
      receiptId,
      sourcePath,
      sourceSystem: pickString(record, ["sourceSystem"], 120),
      providerName: pickString(record, ["providerName"], 120),
      toolName: pickString(record, ["toolName"], 120),
      query: pickString(record, ["query"], 300),
      title: pickString(record, ["title"], 300),
      excerpt: pickString(record, ["excerpt", "summary"], MAX_FACT_TEXT_CHARS),
      retrievedAt: pickString(record, ["retrievedAt", "fetchedAt"], 80),
      hash: pickString(record, ["hash"], 180),
    });
  }
  return evidence.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
}

function normalizeMemoAuthorities(records: Array<Record<string, unknown>>, diagnostics: EvidenceLedgerDiagnostic[]): ResearchMemoAuthorityManifestItem[] {
  const seen = new Set<string>();
  const authorities: ResearchMemoAuthorityManifestItem[] = [];
  for (const record of records) {
    const recordId = pickString(record, ["recordId", "id"], 180);
    const status = pickString(record, ["status"], 80);
    if (!recordId || !status) {
      diagnostics.push({ code: "invalid-ledger-authority-record", severity: "warning", message: "Research memo authority is missing an authority record ID or lookup status.", sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY });
      continue;
    }
    if (seen.has(recordId)) continue;
    seen.add(recordId);
    authorities.push({
      recordId,
      input: pickString(record, ["input"], 300),
      status,
      normalizedCitation: pickString(record, ["normalizedCitation"], 300),
      caseName: pickString(record, ["caseName"], 400),
      courtListenerUrl: pickString(record, ["courtListenerUrl"], 500),
      absoluteUrl: pickString(record, ["absoluteUrl"], 500),
    });
  }
  return authorities.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function normalizeMemoConclusions(records: Array<Record<string, unknown>>, diagnostics: EvidenceLedgerDiagnostic[]): ResearchMemoConclusionManifestItem[] {
  const seen = new Set<string>();
  const conclusions: ResearchMemoConclusionManifestItem[] = [];
  for (const record of records) {
    const conclusionId = pickString(record, ["conclusionId", "id"], 180);
    const text = pickString(record, ["text", "summary"], MAX_FACT_TEXT_CHARS);
    if (!conclusionId || !text) {
      diagnostics.push({ code: "invalid-ledger-conclusion", severity: "warning", message: "Research memo conclusion is missing a conclusion ID or bounded text.", sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY });
      continue;
    }
    if (seen.has(conclusionId)) continue;
    seen.add(conclusionId);
    conclusions.push({
      conclusionId,
      text,
      supportReceiptIds: stringArray(record.supportReceiptIds),
      supportAuthorityRecordIds: stringArray(record.supportAuthorityRecordIds),
      unresolvedGap: record.unresolvedGap === true,
    });
  }
  return conclusions.sort((left, right) => left.conclusionId.localeCompare(right.conclusionId));
}

function makeSourceLink(receipt: ResearchMemoEvidenceManifestItem, factId: string, index: number): EvidenceLedgerSourceLink {
  return {
    sourceLinkId: `${factId}-SRC-${String(index + 1).padStart(3, "0")}`,
    receiptId: receipt.receiptId,
    sourcePath: receipt.sourcePath,
    sourceSystem: receipt.sourceSystem,
    providerName: receipt.providerName,
    toolName: receipt.toolName,
    query: receipt.query,
    title: receipt.title,
    retrievedAt: receipt.retrievedAt,
    hash: receipt.hash,
  };
}

function citationStatusesForFact(params: {
  factId: string;
  sourceLinks: EvidenceLedgerSourceLink[];
  authorityRecordIds: string[];
  authoritiesById: Map<string, ResearchMemoAuthorityManifestItem>;
  unresolvedGap: boolean;
}): EvidenceLedgerCitationStatus[] {
  const statuses: EvidenceLedgerCitationStatus[] = [];
  if (params.sourceLinks.length === 0) {
    statuses.push({ citationStatusId: `${params.factId}-CIT-001`, factId: params.factId, status: "missing-source-link", message: "No accepted source path is linked to this ledger row.", unresolved: true, support: false });
  } else {
    for (const [index, link] of params.sourceLinks.entries()) {
      statuses.push({ citationStatusId: `${params.factId}-CIT-SRC-${String(index + 1).padStart(3, "0")}`, factId: params.factId, status: "source-linked-local-evidence", receiptId: link.receiptId, message: `Local source receipt ${link.receiptId} is linked by path only; it is not legal or factual verification.`, unresolved: false, support: false });
    }
  }

  for (const recordId of params.authorityRecordIds) {
    const authority = params.authoritiesById.get(recordId);
    const matchedWithUrl = authority?.status === "matched" && Boolean(authority.courtListenerUrl ?? authority.absoluteUrl);
    statuses.push({
      citationStatusId: `${params.factId}-CIT-AUTH-${recordId}`,
      factId: params.factId,
      status: matchedWithUrl ? "matched-courtlistener-lookup-record" : "unresolved-authority-lookup-record",
      authorityRecordId: recordId,
      message: matchedWithUrl
        ? `Authority record ${recordId} has a matched CourtListener lookup URL, but this is not good-law or citation-format validation.`
        : `Authority record ${recordId} is missing, unmatched, ambiguous, unavailable, or lacks a CourtListener URL and remains unresolved.`,
      unresolved: !matchedWithUrl,
      support: false,
    });
  }

  statuses.push({ citationStatusId: `${params.factId}-CIT-HUMAN`, factId: params.factId, status: "needs-human-citation-verification", message: "Human citation and source verification is still required before any use outside this draft workflow.", unresolved: false, support: false });
  return statuses;
}

function confidenceForFact(params: { sourceLinks: EvidenceLedgerSourceLink[]; citationStatuses: EvidenceLedgerCitationStatus[]; diagnostics: EvidenceLedgerDiagnostic[]; unresolvedGap: boolean }): EvidenceLedgerConfidence {
  if (params.sourceLinks.length === 0) return "unsupported";
  if (params.unresolvedGap) return "low";
  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "low";
  if (params.citationStatuses.some((status) => status.status === "missing-source-link")) return "unsupported";
  if (params.citationStatuses.some((status) => status.status === "unresolved-authority-lookup-record")) return "medium";
  return "high";
}

function buildFacts(params: {
  evidence: ResearchMemoEvidenceManifestItem[];
  authorities: ResearchMemoAuthorityManifestItem[];
  conclusions: ResearchMemoConclusionManifestItem[];
  diagnostics: EvidenceLedgerDiagnostic[];
}): EvidenceLedgerFact[] {
  const facts: EvidenceLedgerFact[] = [];
  const evidenceByReceiptId = new Map(params.evidence.map((item) => [item.receiptId, item]));
  const authoritiesById = new Map(params.authorities.map((item) => [item.recordId, item]));
  const usedReceiptIds = new Set<string>();
  const usedAuthorityRecordIds = new Set<string>();

  for (const [index, conclusion] of params.conclusions.entries()) {
    const factId = `F-${String(index + 1).padStart(3, "0")}`;
    const factDiagnostics: EvidenceLedgerDiagnostic[] = [];
    const sourceLinks = conclusion.supportReceiptIds
      .map((receiptId, sourceIndex) => {
        const receipt = evidenceByReceiptId.get(receiptId);
        if (!receipt) {
          factDiagnostics.push({ code: "missing-supported-receipt", severity: "error", message: `Conclusion ${conclusion.conclusionId} references receipt ${receiptId}, but that receipt is not present in the research memo evidence manifest.`, sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY, factId });
          return undefined;
        }
        usedReceiptIds.add(receiptId);
        return makeSourceLink(receipt, factId, sourceIndex);
      })
      .filter((link): link is EvidenceLedgerSourceLink => Boolean(link));
    const authorityRecordIds = conclusion.supportAuthorityRecordIds.filter((recordId) => {
      if (!authoritiesById.has(recordId)) {
        factDiagnostics.push({ code: "missing-supported-authority", severity: "warning", message: `Conclusion ${conclusion.conclusionId} references authority record ${recordId}, but that record is not present in the research memo authority manifest.`, sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY, factId });
      }
      usedAuthorityRecordIds.add(recordId);
      return true;
    }).sort();
    const citationStatus = citationStatusesForFact({ factId, sourceLinks, authorityRecordIds, authoritiesById, unresolvedGap: conclusion.unresolvedGap });
    facts.push({
      factId,
      factText: conclusion.text,
      sourceLinks,
      claimLinks: [{ claimLinkId: `${factId}-CLM-001`, conclusionId: conclusion.conclusionId, factId, label: `Research memo conclusion ${conclusion.conclusionId}`, status: conclusion.unresolvedGap ? "unresolved-placeholder" : "upstream-research-memo-conclusion", createsClaimMap: false }],
      authorityRecordIds,
      confidence: confidenceForFact({ sourceLinks, citationStatuses: citationStatus, diagnostics: factDiagnostics, unresolvedGap: conclusion.unresolvedGap }),
      citationStatus,
      unresolvedGap: conclusion.unresolvedGap,
      diagnostics: factDiagnostics,
      verified: false,
    });
  }

  const nextIndex = facts.length;
  for (const receipt of params.evidence) {
    if (usedReceiptIds.has(receipt.receiptId)) continue;
    const factId = `F-${String(facts.length + 1).padStart(3, "0")}`;
    const sourceLinks = [makeSourceLink(receipt, factId, 0)];
    const citationStatus = citationStatusesForFact({ factId, sourceLinks, authorityRecordIds: [], authoritiesById, unresolvedGap: true });
    const diagnostics: EvidenceLedgerDiagnostic[] = [{ code: "unlinked-evidence-placeholder", severity: "warning", message: `Receipt ${receipt.receiptId} is present in the research memo evidence manifest but is not linked to an upstream research memo conclusion.`, sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY, factId }];
    facts.push({
      factId,
      factText: boundedText(receipt.excerpt ?? receipt.title ?? `Source receipt ${receipt.receiptId} is available at ${receipt.sourcePath}.`, MAX_FACT_TEXT_CHARS) ?? `Source receipt ${receipt.receiptId} is available.`,
      sourceLinks,
      claimLinks: [{ claimLinkId: `${factId}-CLM-001`, factId, label: "Unresolved placeholder; no upstream research memo conclusion linked this receipt.", status: "unresolved-placeholder", createsClaimMap: false }],
      authorityRecordIds: [],
      confidence: confidenceForFact({ sourceLinks, citationStatuses: citationStatus, diagnostics, unresolvedGap: true }),
      citationStatus,
      unresolvedGap: true,
      diagnostics,
      verified: false,
    });
  }

  for (const authority of params.authorities) {
    if (usedAuthorityRecordIds.has(authority.recordId) || authority.status === "matched") continue;
    const factId = `F-${String(facts.length + 1).padStart(3, "0")}`;
    const citationStatus = citationStatusesForFact({ factId, sourceLinks: [], authorityRecordIds: [authority.recordId], authoritiesById, unresolvedGap: true });
    const diagnostics: EvidenceLedgerDiagnostic[] = [{ code: "unlinked-unresolved-authority", severity: "warning", message: `Authority record ${authority.recordId} is ${authority.status} and is not linked to an upstream research memo conclusion; it remains an unresolved citation-status entry.`, sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY, factId }];
    facts.push({
      factId,
      factText: boundedText(`Unresolved authority lookup record ${authority.recordId}: ${authority.normalizedCitation ?? authority.input ?? authority.status}.`, MAX_FACT_TEXT_CHARS) ?? `Unresolved authority lookup record ${authority.recordId}.`,
      sourceLinks: [],
      claimLinks: [{ claimLinkId: `${factId}-CLM-001`, factId, label: "Unresolved placeholder; unresolved authority record is not linked to a research memo conclusion.", status: "unresolved-placeholder", createsClaimMap: false }],
      authorityRecordIds: [authority.recordId],
      confidence: "unsupported",
      citationStatus,
      unresolvedGap: true,
      diagnostics,
      verified: false,
    });
  }

  if (facts.length === 0) {
    const factId = `F-${String(nextIndex + 1).padStart(3, "0")}`;
    const citationStatus = citationStatusesForFact({ factId, sourceLinks: [], authorityRecordIds: [], authoritiesById, unresolvedGap: true });
    facts.push({
      factId,
      factText: "Unresolved gap: no research memo evidence or conclusions were available to derive ledger facts.",
      sourceLinks: [],
      claimLinks: [{ claimLinkId: `${factId}-CLM-001`, factId, label: "Unresolved placeholder; prerequisite research memo facts are missing.", status: "unresolved-placeholder", createsClaimMap: false }],
      authorityRecordIds: [],
      confidence: "unsupported",
      citationStatus,
      unresolvedGap: true,
      diagnostics: [{ code: "no-ledger-facts", severity: "error", message: "No safe research memo facts were available for evidence ledger generation.", sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY, factId }],
      verified: false,
    });
  }

  return facts.sort((left, right) => left.factId.localeCompare(right.factId));
}

function deriveStatus(params: { memoPresent: boolean; memoParsed: boolean; memoStatus?: string; facts: EvidenceLedgerFact[]; diagnostics: EvidenceLedgerDiagnostic[] }): EvidenceLedgerStatus {
  if (!params.memoPresent || !params.memoParsed) return "blocked";
  if (params.memoStatus && params.memoStatus !== "completed") {
    if (["failed", "blocked"].includes(params.memoStatus)) return "blocked";
    return "partial";
  }
  if (params.facts.length === 0 || params.facts.every((fact) => fact.confidence === "unsupported")) return "blocked";
  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "partial";
  if (params.facts.some((fact) => fact.unresolvedGap || fact.confidence === "medium" || fact.confidence === "low" || fact.confidence === "unsupported")) return "partial";
  if (params.diagnostics.length > 0) return "partial";
  return "completed";
}

function countLedger(facts: EvidenceLedgerFact[]): EvidenceLedgerCounts {
  const citationStatuses = { ...EMPTY_CITATION_COUNTS };
  const confidence = { ...EMPTY_CONFIDENCE_COUNTS };
  const sourceLinkIds = new Set<string>();
  const claimLinkIds = new Set<string>();
  let unresolvedGaps = 0;
  for (const fact of facts) {
    confidence[fact.confidence] += 1;
    if (fact.unresolvedGap) unresolvedGaps += 1;
    for (const link of fact.sourceLinks) sourceLinkIds.add(link.sourceLinkId);
    for (const link of fact.claimLinks) claimLinkIds.add(link.claimLinkId);
    for (const status of fact.citationStatus) citationStatuses[status.status] += 1;
  }
  return { facts: facts.length, sourceLinks: sourceLinkIds.size, claimLinks: claimLinkIds.size, unresolvedGaps, citationStatuses, confidence };
}

function flattenSourceLinks(facts: EvidenceLedgerFact[]): EvidenceLedgerSourceLink[] {
  return facts.flatMap((fact) => fact.sourceLinks).sort((left, right) => left.sourceLinkId.localeCompare(right.sourceLinkId));
}

function flattenClaimLinks(facts: EvidenceLedgerFact[]): EvidenceLedgerClaimLink[] {
  return facts.flatMap((fact) => fact.claimLinks).sort((left, right) => left.claimLinkId.localeCompare(right.claimLinkId));
}

function flattenCitationStatuses(facts: EvidenceLedgerFact[]): EvidenceLedgerCitationStatus[] {
  return facts.flatMap((fact) => fact.citationStatus).sort((left, right) => left.citationStatusId.localeCompare(right.citationStatusId));
}

function memoStatusDiagnostic(status?: string, taskId?: string): EvidenceLedgerDiagnostic[] {
  if (!status || status === "completed") return [];
  return [{
    code: "research-memo-status-blocker",
    severity: status === "failed" || status === "blocked" ? "error" : "warning",
    message: `research-memo-status reports ${status}. The evidence ledger cannot treat the research memo as completed support.`,
    sourceDocumentKey: RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
    sourceTaskId: taskId,
  }];
}

export async function collectCounterLawsuitEvidenceLedgerInputs(options: CollectCounterLawsuitEvidenceLedgerInputsOptions): Promise<CounterLawsuitEvidenceLedgerResult> {
  const { researchMemoTask, evidenceLedgerTask } = await locateCounterLawsuitEvidenceLedgerStageTasks({ taskStore: options.taskStore, runId: options.runId });
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const [memo, memoStatus] = await Promise.all([
    readParsedDocument(options.taskStore, researchMemoTask.id, RESEARCH_MEMO_DOCUMENT_KEY),
    readParsedDocument(options.taskStore, researchMemoTask.id, RESEARCH_MEMO_STATUS_DOCUMENT_KEY),
  ]);
  const memoStatusValue = typeof memoStatus.manifest?.status === "string" ? memoStatus.manifest.status : undefined;
  const parseDiagnostics = normalizeDiagnostics(memo.diagnostics, memoStatus.document ? memoStatus.diagnostics : [], memoStatusDiagnostic(memoStatusValue, researchMemoTask.id));
  const itemDiagnostics: EvidenceLedgerDiagnostic[] = [];
  const memoDiagnostics = normalizeDiagnostics(manifestArray(memo.manifest, ["diagnostics"]) as unknown as ResearchMemoDiagnostic[]);
  const evidence = normalizeMemoEvidence(manifestArray(memo.manifest, ["evidence"]), itemDiagnostics);
  const authorities = normalizeMemoAuthorities(manifestArray(memo.manifest, ["authorities"]), itemDiagnostics);
  const conclusions = normalizeMemoConclusions(manifestArray(memo.manifest, ["conclusions"]), itemDiagnostics);
  const facts = buildFacts({ evidence, authorities, conclusions, diagnostics: itemDiagnostics });
  const allDiagnostics = normalizeDiagnostics(parseDiagnostics, memoDiagnostics, itemDiagnostics, facts.flatMap((fact) => fact.diagnostics));
  const status = deriveStatus({ memoPresent: Boolean(memo.document), memoParsed: Boolean(memo.manifest), memoStatus: memoStatusValue, facts, diagnostics: allDiagnostics });
  const sourceDocuments: EvidenceLedgerSourceDocumentSummary[] = [
    { taskId: researchMemoTask.id, key: RESEARCH_MEMO_DOCUMENT_KEY, present: Boolean(memo.document), parsedFrom: memo.source, status: typeof memo.manifest?.status === "string" ? memo.manifest.status : undefined },
    { taskId: researchMemoTask.id, key: RESEARCH_MEMO_STATUS_DOCUMENT_KEY, present: Boolean(memoStatus.document), parsedFrom: memoStatus.source, status: memoStatusValue },
  ];
  return {
    runId: options.runId,
    status,
    generatedAt,
    researchMemoTaskId: researchMemoTask.id,
    evidenceLedgerTaskId: evidenceLedgerTask.id,
    ledgerDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
    statusDocumentKey: status === "completed" ? undefined : EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
    sourceDocuments,
    facts,
    sourceLinks: flattenSourceLinks(facts),
    claimLinks: flattenClaimLinks(facts),
    citationStatuses: flattenCitationStatuses(facts),
    confidenceRubric: EVIDENCE_LEDGER_CONFIDENCE_RUBRIC,
    diagnostics: allDiagnostics,
    counts: countLedger(facts),
    safetyNotice: EVIDENCE_LEDGER_SAFETY_NOTICE,
  };
}

export function evidenceLedgerSummaryFromResult(result: CounterLawsuitEvidenceLedgerResult): CounterLawsuitEvidenceLedgerSummary {
  return {
    runId: result.runId,
    status: result.status,
    ledgerDocumentKey: result.ledgerDocumentKey,
    statusDocumentKey: result.statusDocumentKey,
    factCount: result.counts.facts,
    sourceLinkCount: result.counts.sourceLinks,
    claimLinkCount: result.counts.claimLinks,
    unresolvedGapCount: result.counts.unresolvedGaps,
    citationStatusCounts: result.counts.citationStatuses,
    confidenceCounts: result.counts.confidence,
    diagnostics: result.diagnostics,
    safetyNotice: result.safetyNotice,
  };
}

export function buildEvidenceLedgerManifest(result: CounterLawsuitEvidenceLedgerResult): Record<string, unknown> {
  return {
    runId: result.runId,
    generatedAt: result.generatedAt,
    status: result.status,
    sourceDocuments: result.sourceDocuments,
    researchMemoTaskId: result.researchMemoTaskId,
    evidenceLedgerTaskId: result.evidenceLedgerTaskId,
    facts: result.facts,
    sourceLinks: result.sourceLinks,
    claimLinks: result.claimLinks,
    citationStatuses: result.citationStatuses,
    confidenceRubric: result.confidenceRubric,
    diagnostics: result.diagnostics,
    counts: result.counts,
    safetyNotice: result.safetyNotice,
  };
}

function formatDiagnostics(diagnostics: EvidenceLedgerDiagnostic[]): string {
  return diagnostics.map((diagnostic) => {
    const severity = diagnostic.severity === "error" || diagnostic.severity === "warning" || diagnostic.severity === "info" ? diagnostic.severity : "warning";
    return `- ${severity.toUpperCase()} ${diagnostic.code}${diagnostic.factId ? ` (${diagnostic.factId})` : ""}${diagnostic.sourceDocumentKey ? ` [${diagnostic.sourceDocumentKey}]` : ""}: ${diagnostic.message}`;
  }).join("\n") || "- None.";
}

function formatFactTable(facts: EvidenceLedgerFact[]): string {
  if (facts.length === 0) return "| Fact ID | Fact text | Sources | Claims | Confidence | Citation status | Verified |\n| --- | --- | --- | --- | --- | --- | --- |\n";
  const rows = facts.map((fact) => `| ${fact.factId} | ${fact.factText.replace(/\|/g, "\\|")} | ${fact.sourceLinks.map((link) => `${link.receiptId}: ${link.sourcePath}`).join("<br>") || "missing source link"} | ${fact.claimLinks.map((link) => link.conclusionId ?? link.status).join(", ")} | ${fact.confidence} | ${fact.citationStatus.map((status) => status.status).join(", ")} | false |`);
  return ["| Fact ID | Fact text | Sources | Claims | Confidence | Citation status | Verified |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

export function buildEvidenceLedgerMarkdown(result: CounterLawsuitEvidenceLedgerResult): string {
  const manifest = buildEvidenceLedgerManifest(result);
  return `# Counter-lawsuit structured evidence ledger

${EVIDENCE_LEDGER_SAFETY_NOTICE}

This ledger also preserves the upstream memo limit: ${RESEARCH_MEMO_SAFETY_NOTICE}

## Run context

- Workflow run ID: ${result.runId}
- Research memo task ID: ${result.researchMemoTaskId ?? "unknown"}
- Evidence ledger task ID: ${result.evidenceLedgerTaskId ?? "unknown"}
- Generated at: ${result.generatedAt}
- Status: ${result.status}

## Ledger summary

- Fact rows: ${result.counts.facts}
- Source links: ${result.counts.sourceLinks}
- Preliminary claim links: ${result.counts.claimLinks}
- Unresolved gaps: ${result.counts.unresolvedGaps}
- Citation status counts: ${Object.entries(result.counts.citationStatuses).map(([key, count]) => `${key}: ${count}`).join(", ")}
- Confidence counts: ${Object.entries(result.counts.confidence).map(([key, count]) => `${key}: ${count}`).join(", ")}

## Fact table

${formatFactTable(result.facts)}

## Source-link appendix

${result.sourceLinks.map((link) => `- ${link.sourceLinkId}: receipt ${link.receiptId}, path ${link.sourcePath}${link.query ? `, query ${link.query}` : ""}`).join("\n") || "- No accepted source links."}

## Preliminary claim-link appendix

These are only upstream research memo conclusion links or unresolved placeholders. This ledger does not create the later claim map.

${result.claimLinks.map((link) => `- ${link.claimLinkId}: fact ${link.factId}, ${link.conclusionId ? `research memo conclusion ${link.conclusionId}` : link.label}, status ${link.status}, creates claim map: false`).join("\n") || "- No claim links."}

## Citation-status appendix

${result.citationStatuses.map((status) => `- ${status.citationStatusId}: ${status.status}${status.receiptId ? `, receipt ${status.receiptId}` : ""}${status.authorityRecordId ? `, authority ${status.authorityRecordId}` : ""}. ${status.message}`).join("\n") || "- No citation statuses."}

## Confidence rubric

${Object.entries(result.confidenceRubric).map(([level, meaning]) => `- ${level}: ${meaning}`).join("\n")}

## Unresolved gaps

${result.facts.filter((fact) => fact.unresolvedGap || fact.confidence === "unsupported" || fact.citationStatus.some((status) => status.unresolved)).map((fact) => `- ${fact.factId}: ${fact.factText}`).join("\n") || "- None recorded beyond draft-only safety limits."}

## Diagnostics

${formatDiagnostics(result.diagnostics)}

## Machine-readable manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

function statusDocumentInput(result: CounterLawsuitEvidenceLedgerResult): { key: typeof EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY; content: string; author: string; metadata: Record<string, unknown> } {
  return {
    key: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
    content: `# Evidence ledger status\n\nStatus: ${result.status}\n\n${EVIDENCE_LEDGER_SAFETY_NOTICE}\n\n## Diagnostics\n${formatDiagnostics(result.diagnostics)}\n`,
    author: "fusion-legal-evidence-ledger",
    metadata: {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: result.runId,
      status: result.status,
      ledgerDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
      statusDocumentKey: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
      factCount: result.counts.facts,
      sourceLinkCount: result.counts.sourceLinks,
      claimLinkCount: result.counts.claimLinks,
      unresolvedGapCount: result.counts.unresolvedGaps,
      citationStatusCounts: result.counts.citationStatuses,
      confidenceCounts: result.counts.confidence,
      diagnostics: result.diagnostics,
      safetyNotice: EVIDENCE_LEDGER_SAFETY_NOTICE,
    },
  };
}

export async function generateCounterLawsuitEvidenceLedger(options: GenerateCounterLawsuitEvidenceLedgerOptions): Promise<CounterLawsuitEvidenceLedgerResult> {
  const result = await collectCounterLawsuitEvidenceLedgerInputs(options);
  try {
    await options.taskStore.upsertTaskDocument(result.evidenceLedgerTaskId ?? "", {
      key: EVIDENCE_LEDGER_DOCUMENT_KEY,
      content: buildEvidenceLedgerMarkdown(result),
      author: "fusion-legal-evidence-ledger",
      metadata: buildEvidenceLedgerManifest(result),
    });

    if (result.status !== "completed") {
      await options.taskStore.upsertTaskDocument(result.evidenceLedgerTaskId ?? "", statusDocumentInput(result));
    } else {
      const staleStatus = await options.taskStore.getTaskDocument(result.evidenceLedgerTaskId ?? "", EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY).catch(() => null);
      if (staleStatus) {
        await options.taskStore.upsertTaskDocument(result.evidenceLedgerTaskId ?? "", statusDocumentInput({ ...result, statusDocumentKey: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY }));
      }
    }

    return result;
  } catch (error) {
    const failedResult: CounterLawsuitEvidenceLedgerResult = {
      ...result,
      status: "failed",
      statusDocumentKey: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
      diagnostics: normalizeDiagnostics(result.diagnostics, [{
        code: "evidence-ledger-generation-failed",
        severity: "error",
        message: `Evidence ledger generation failed: ${error instanceof Error ? error.message : String(error)}`,
        sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
        sourceTaskId: result.evidenceLedgerTaskId,
      }]),
    };
    await options.taskStore.upsertTaskDocument(failedResult.evidenceLedgerTaskId ?? "", statusDocumentInput(failedResult));
    return failedResult;
  }
}

function summaryFromManifest(params: { runId: string; manifest: Record<string, unknown>; statusDocPresent: boolean }): CounterLawsuitEvidenceLedgerSummary {
  const counts = asRecord(params.manifest.counts);
  const citationStatusCounts = asRecord(counts?.citationStatuses) as Record<EvidenceLedgerCitationStatusKind, number> | undefined;
  const confidenceCounts = asRecord(counts?.confidence) as Record<EvidenceLedgerConfidence, number> | undefined;
  const diagnostics = manifestArray(params.manifest, ["diagnostics"]) as unknown as EvidenceLedgerDiagnostic[];
  return {
    runId: params.runId,
    status: typeof params.manifest.status === "string" ? params.manifest.status as EvidenceLedgerStatus : "completed",
    ledgerDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
    statusDocumentKey: params.statusDocPresent ? EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY : undefined,
    factCount: typeof counts?.facts === "number" ? counts.facts : manifestArray(params.manifest, ["facts"]).length,
    sourceLinkCount: typeof counts?.sourceLinks === "number" ? counts.sourceLinks : manifestArray(params.manifest, ["sourceLinks"]).length,
    claimLinkCount: typeof counts?.claimLinks === "number" ? counts.claimLinks : manifestArray(params.manifest, ["claimLinks"]).length,
    unresolvedGapCount: typeof counts?.unresolvedGaps === "number" ? counts.unresolvedGaps : 0,
    citationStatusCounts: { ...EMPTY_CITATION_COUNTS, ...(citationStatusCounts ?? {}) },
    confidenceCounts: { ...EMPTY_CONFIDENCE_COUNTS, ...(confidenceCounts ?? {}) },
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    safetyNotice: EVIDENCE_LEDGER_SAFETY_NOTICE,
  };
}

export async function deriveEvidenceLedgerStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<CounterLawsuitEvidenceLedgerSummary> {
  const { evidenceLedgerTask } = await locateCounterLawsuitEvidenceLedgerStageTasks({ taskStore: params.taskStore, runId: params.runId });
  const doc = await params.taskStore.getTaskDocument(evidenceLedgerTask.id, EVIDENCE_LEDGER_DOCUMENT_KEY).catch(() => null);
  const statusDoc = await params.taskStore.getTaskDocument(evidenceLedgerTask.id, EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY).catch(() => null);
  if (statusDoc && (!doc || typeof statusDoc.metadata?.status === "string" && statusDoc.metadata.status !== "completed")) {
    const statusManifest = parseManifestFromDocument(statusDoc, EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY).manifest ?? {};
    return {
      runId: params.runId,
      status: typeof statusManifest.status === "string" ? statusManifest.status as EvidenceLedgerStatus : "failed",
      ledgerDocumentKey: doc ? EVIDENCE_LEDGER_DOCUMENT_KEY : undefined,
      statusDocumentKey: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
      factCount: typeof statusManifest.factCount === "number" ? statusManifest.factCount : 0,
      sourceLinkCount: typeof statusManifest.sourceLinkCount === "number" ? statusManifest.sourceLinkCount : 0,
      claimLinkCount: typeof statusManifest.claimLinkCount === "number" ? statusManifest.claimLinkCount : 0,
      unresolvedGapCount: typeof statusManifest.unresolvedGapCount === "number" ? statusManifest.unresolvedGapCount : 0,
      citationStatusCounts: { ...EMPTY_CITATION_COUNTS, ...(asRecord(statusManifest.citationStatusCounts) ?? {}) },
      confidenceCounts: { ...EMPTY_CONFIDENCE_COUNTS, ...(asRecord(statusManifest.confidenceCounts) ?? {}) },
      diagnostics: manifestArray(statusManifest, ["diagnostics"]) as unknown as EvidenceLedgerDiagnostic[],
      safetyNotice: EVIDENCE_LEDGER_SAFETY_NOTICE,
    };
  }
  if (!doc) {
    return {
      runId: params.runId,
      status: "not-run",
      ledgerDocumentKey: undefined,
      statusDocumentKey: statusDoc ? EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY : undefined,
      factCount: 0,
      sourceLinkCount: 0,
      claimLinkCount: 0,
      unresolvedGapCount: 0,
      citationStatusCounts: { ...EMPTY_CITATION_COUNTS },
      confidenceCounts: { ...EMPTY_CONFIDENCE_COUNTS },
      diagnostics: [],
      safetyNotice: EVIDENCE_LEDGER_SAFETY_NOTICE,
    };
  }
  const manifest = parseManifestFromDocument(doc, EVIDENCE_LEDGER_DOCUMENT_KEY).manifest ?? {};
  return summaryFromManifest({ runId: params.runId, manifest, statusDocPresent: Boolean(statusDoc) });
}
