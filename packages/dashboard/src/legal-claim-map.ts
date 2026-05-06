import type { Task, TaskDocument, TaskStore } from "@fusion/core";
import { notFound } from "./api-error.js";
import {
  EVIDENCE_LEDGER_DOCUMENT_KEY,
  EVIDENCE_LEDGER_SAFETY_NOTICE,
  EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
  type EvidenceLedgerCitationStatus,
  type EvidenceLedgerClaimLink,
  type EvidenceLedgerConfidence,
  type EvidenceLedgerDiagnostic,
  type EvidenceLedgerFact,
  type EvidenceLedgerSourceDocumentSummary,
  type EvidenceLedgerSourceLink,
} from "./legal-evidence-ledger.js";
import {
  RESEARCH_MEMO_DOCUMENT_KEY,
  RESEARCH_MEMO_SAFETY_NOTICE,
} from "./legal-research-memo.js";
import { COUNTER_LAWSUIT_WORKFLOW_KIND } from "./legal-workflow-orchestrator.js";

export const CLAIM_MAP_DOCUMENT_KEY = "claim-map";
export const CLAIM_MAP_STATUS_DOCUMENT_KEY = "claim-map-status";
export const CLAIM_MAP_SAFETY_NOTICE = "Draft-only structured claim map generated from the persisted evidence ledger manifest. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.";

export type ClaimMapStatus = "completed" | "partial" | "blocked" | "failed" | "not-run";
export type ClaimMapDiagnosticSeverity = "info" | "warning" | "error";
export type ClaimMapElementStatus = "supported-draft" | "partial-draft" | "missing-proof" | "blocked";
export type ClaimMapMissingProofScope = "workflow" | "claim" | "element" | "allegation" | "source" | "authority" | "citation";

export interface ClaimMapDiagnostic {
  code: string;
  severity: ClaimMapDiagnosticSeverity;
  message: string;
  sourceDocumentKey?: string;
  sourceTaskId?: string;
  claimId?: string;
  elementId?: string;
  allegationId?: string;
  factId?: string;
}

export interface ClaimMapSupportingEvidence {
  supportingEvidenceId: string;
  claimId: string;
  elementId: string;
  allegationId: string;
  factId: string;
  sourceLinkId: string;
  receiptId: string;
  sourcePath: string;
  citationStatusIds: string[];
  verified: false;
}

export interface ClaimMapAllegation {
  allegationId: string;
  claimId: string;
  elementId: string;
  factId: string;
  allegationText: string;
  supportingEvidenceIds: string[];
  sourceLinkIds: string[];
  receiptIds: string[];
  sourcePaths: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  upstreamConfidence: EvidenceLedgerConfidence;
  verified: false;
  unresolvedDraftOnly: boolean;
}

export interface ClaimMapElement {
  elementId: string;
  claimId: string;
  label: string;
  status: ClaimMapElementStatus;
  allegationIds: string[];
  supportingEvidenceIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  missingProofIds: string[];
  invented: false;
  verified: false;
}

export interface ClaimMapClaim {
  claimId: string;
  conclusionId?: string;
  label: string;
  status: ClaimMapElementStatus;
  elementIds: string[];
  allegationIds: string[];
  supportingEvidenceIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  missingProofIds: string[];
  unresolvedDraftOnly: boolean;
  verified: false;
}

export interface ClaimMapMissingProof {
  missingProofId: string;
  scope: ClaimMapMissingProofScope;
  severity: ClaimMapDiagnosticSeverity;
  reason: string;
  claimId?: string;
  elementId?: string;
  allegationId?: string;
  factId?: string;
  sourceDocumentKey?: string;
  sourceTaskId?: string;
  authorityRecordId?: string;
  citationStatusId?: string;
  unresolved: true;
}

export type ClaimMapSourceDocumentSummary = EvidenceLedgerSourceDocumentSummary;

export interface ClaimMapCounts {
  claims: number;
  elements: number;
  allegations: number;
  supportingEvidence: number;
  missingProof: number;
  unresolvedGaps: number;
}

export interface CounterLawsuitClaimMapResult {
  runId: string;
  status: ClaimMapStatus;
  generatedAt: string;
  researchMemoTaskId?: string;
  evidenceLedgerTaskId?: string;
  claimMapTaskId?: string;
  claimMapDocumentKey: typeof CLAIM_MAP_DOCUMENT_KEY;
  statusDocumentKey?: typeof CLAIM_MAP_STATUS_DOCUMENT_KEY;
  sourceDocuments: ClaimMapSourceDocumentSummary[];
  claims: ClaimMapClaim[];
  elements: ClaimMapElement[];
  allegations: ClaimMapAllegation[];
  supportingEvidence: ClaimMapSupportingEvidence[];
  missingProof: ClaimMapMissingProof[];
  diagnostics: ClaimMapDiagnostic[];
  counts: ClaimMapCounts;
  safetyNotice: typeof CLAIM_MAP_SAFETY_NOTICE;
}

export interface CounterLawsuitClaimMapSummary {
  runId: string;
  status: ClaimMapStatus;
  claimMapDocumentKey?: typeof CLAIM_MAP_DOCUMENT_KEY | string;
  statusDocumentKey?: typeof CLAIM_MAP_STATUS_DOCUMENT_KEY | string;
  claimCount: number;
  elementCount: number;
  allegationCount: number;
  supportingEvidenceCount: number;
  missingProofCount: number;
  unresolvedGapCount: number;
  diagnostics: ClaimMapDiagnostic[];
  safetyNotice: typeof CLAIM_MAP_SAFETY_NOTICE;
}

export interface GenerateCounterLawsuitClaimMapOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument" | "upsertTaskDocument">;
  runId: string;
  force?: boolean;
  now?: () => Date;
}

export interface CollectCounterLawsuitClaimMapInputsOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
  now?: () => Date;
}

interface ParsedDocument {
  document: TaskDocument | null;
  source: ClaimMapSourceDocumentSummary["parsedFrom"];
  manifest?: Record<string, unknown>;
  diagnostics: ClaimMapDiagnostic[];
}

const MAX_TEXT_CHARS = 900;
const MAX_ALLEGATION_TEXT_CHARS = 700;
const MAX_DIAGNOSTICS = 50;
const AUTH_HEADER_RE = /(["']?(?:authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^"'\n\r,}]+/gi;
const TOKEN_RE = /["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|Token\s+\S{8,}|(?:sk|pk|ghp|github_pat|obsidian)[A-Za-z0-9_:\-.=+/]{8,}/gi;
const SECRET_FLAG_VALUE_RE = /(--[A-Za-z0-9_.-]*(?:token|secret|key|password|credential|auth)[A-Za-z0-9_.-]*)(\s+)(?:"[^"]+"|'[^']+'|\S+)/gi;

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

function manifestArray(manifest: Record<string, unknown> | undefined, keys: string[]): Array<Record<string, unknown>> {
  if (!manifest) return [];
  for (const key of keys) {
    const value = manifest[key];
    if (Array.isArray(value)) return value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record));
  }
  return [];
}

function stringArray(value: unknown, maxChars = 180): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => boundedText(item, maxChars)).filter((item): item is string => Boolean(item));
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function findStageTask(tasks: Task[], stage: string, documentKey: string): Task | undefined {
  return tasks.find((task) => task.sourceMetadata?.workflowStage === stage)
    ?? tasks.find((task) => task.sourceMetadata?.documentKey === documentKey);
}

export async function locateCounterLawsuitClaimMapStageTasks(params: {
  taskStore: Pick<TaskStore, "listTasks">;
  runId: string;
}): Promise<{ tasks: Task[]; researchMemoTask?: Task; evidenceLedgerTask: Task; claimMapTask: Task }> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId))
    .sort((left, right) => Number(left.sourceMetadata?.workflowStageIndex ?? 0) - Number(right.sourceMetadata?.workflowStageIndex ?? 0));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  const researchMemoTask = findStageTask(tasks, "research-memo", RESEARCH_MEMO_DOCUMENT_KEY);
  const evidenceLedgerTask = findStageTask(tasks, "evidence-ledger", EVIDENCE_LEDGER_DOCUMENT_KEY);
  if (!evidenceLedgerTask) throw notFound(`Legal workflow run ${params.runId} has no evidence-ledger stage task`);
  const claimMapTask = findStageTask(tasks, "claim-map", CLAIM_MAP_DOCUMENT_KEY);
  if (!claimMapTask) throw notFound(`Legal workflow run ${params.runId} has no claim-map stage task`);
  return { tasks, researchMemoTask, evidenceLedgerTask, claimMapTask };
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

function normalizeDiagnostics(...diagnosticGroups: Array<Array<ClaimMapDiagnostic | EvidenceLedgerDiagnostic> | undefined>): ClaimMapDiagnostic[] {
  const result: ClaimMapDiagnostic[] = [];
  for (const group of diagnosticGroups) {
    for (const diagnostic of group ?? []) {
      result.push({
        code: boundedText(diagnostic.code, 180) ?? "diagnostic",
        severity: diagnostic.severity === "error" || diagnostic.severity === "warning" || diagnostic.severity === "info" ? diagnostic.severity : "warning",
        message: boundedText(diagnostic.message, 500) ?? boundedText(diagnostic.code, 180) ?? "diagnostic",
        sourceDocumentKey: boundedText(diagnostic.sourceDocumentKey, 180),
        sourceTaskId: boundedText(diagnostic.sourceTaskId, 180),
        claimId: "claimId" in diagnostic ? boundedText(diagnostic.claimId, 180) : undefined,
        elementId: "elementId" in diagnostic ? boundedText(diagnostic.elementId, 180) : undefined,
        allegationId: "allegationId" in diagnostic ? boundedText(diagnostic.allegationId, 180) : undefined,
        factId: "factId" in diagnostic ? boundedText(diagnostic.factId, 180) : undefined,
      });
    }
  }
  return result.slice(0, MAX_DIAGNOSTICS);
}

function normalizeSourceLinks(records: unknown, diagnostics: ClaimMapDiagnostic[], factId: string): EvidenceLedgerSourceLink[] {
  if (!Array.isArray(records)) return [];
  const links: EvidenceLedgerSourceLink[] = [];
  for (const record of records.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))) {
    const sourceLinkId = boundedText(record.sourceLinkId, 180);
    const receiptId = boundedText(record.receiptId, 180);
    const sourcePath = boundedText(record.sourcePath, 500);
    if (!sourceLinkId || !receiptId || !sourcePath) {
      diagnostics.push({
        code: "invalid-claim-map-source-link",
        severity: "error",
        message: "Evidence ledger source link is missing a source-link ID, receipt ID, or source path and cannot support a claim-map allegation.",
        sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
        factId,
      });
      continue;
    }
    links.push({
      sourceLinkId,
      receiptId,
      sourcePath,
      sourceSystem: boundedText(record.sourceSystem, 120),
      providerName: boundedText(record.providerName, 120),
      toolName: boundedText(record.toolName, 120),
      query: boundedText(record.query, 300),
      title: boundedText(record.title, 300),
      retrievedAt: boundedText(record.retrievedAt, 80),
      hash: boundedText(record.hash, 180),
    });
  }
  return links.sort((left, right) => left.sourceLinkId.localeCompare(right.sourceLinkId));
}

function normalizeClaimLinks(records: unknown): EvidenceLedgerClaimLink[] {
  if (!Array.isArray(records)) return [];
  return records.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record)).map((record) => ({
    claimLinkId: boundedText(record.claimLinkId, 180) ?? "",
    conclusionId: boundedText(record.conclusionId, 180),
    factId: boundedText(record.factId, 180) ?? "",
    label: boundedText(record.label, 300) ?? "Unresolved placeholder claim link",
    status: record.status === "upstream-research-memo-conclusion" ? "upstream-research-memo-conclusion" : "unresolved-placeholder",
    createsClaimMap: false,
    elements: Array.isArray(record.elements) ? record.elements : undefined,
    legalElements: Array.isArray(record.legalElements) ? record.legalElements : undefined,
    elementLabels: Array.isArray(record.elementLabels) ? record.elementLabels : undefined,
  } as EvidenceLedgerClaimLink & { elements?: unknown; legalElements?: unknown; elementLabels?: unknown })).filter((link) => link.claimLinkId && link.factId)
    .sort((left, right) => left.claimLinkId.localeCompare(right.claimLinkId));
}

function normalizeCitationStatuses(records: unknown): EvidenceLedgerCitationStatus[] {
  if (!Array.isArray(records)) return [];
  return records.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record)).map((record) => ({
    citationStatusId: boundedText(record.citationStatusId, 180) ?? "",
    factId: boundedText(record.factId, 180),
    status: boundedText(record.status, 180) as EvidenceLedgerCitationStatus["status"] ?? "needs-human-citation-verification",
    receiptId: boundedText(record.receiptId, 180),
    authorityRecordId: boundedText(record.authorityRecordId, 180),
    message: boundedText(record.message, 500) ?? "Citation status requires human review.",
    unresolved: record.unresolved === true,
    support: false as const,
  })).filter((status) => status.citationStatusId)
    .sort((left, right) => left.citationStatusId.localeCompare(right.citationStatusId));
}

function normalizeFact(record: Record<string, unknown>, diagnostics: ClaimMapDiagnostic[]): EvidenceLedgerFact | undefined {
  const factId = boundedText(record.factId, 180);
  const factText = boundedText(record.factText, MAX_ALLEGATION_TEXT_CHARS);
  if (!factId || !factText) {
    diagnostics.push({ code: "invalid-claim-map-fact", severity: "warning", message: "Evidence ledger fact is missing a fact ID or bounded fact text.", sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
    return undefined;
  }
  const factDiagnostics = normalizeDiagnostics(manifestArray(record, ["diagnostics"]) as unknown as EvidenceLedgerDiagnostic[]);
  const sourceLinks = normalizeSourceLinks(record.sourceLinks, factDiagnostics, factId);
  diagnostics.push(...factDiagnostics);
  const confidence = ["high", "medium", "low", "unsupported"].includes(String(record.confidence)) ? record.confidence as EvidenceLedgerConfidence : "unsupported";
  return {
    factId,
    factText,
    sourceLinks,
    claimLinks: normalizeClaimLinks(record.claimLinks),
    authorityRecordIds: stringArray(record.authorityRecordIds),
    confidence,
    citationStatus: normalizeCitationStatuses(record.citationStatus),
    unresolvedGap: record.unresolvedGap === true,
    diagnostics: factDiagnostics,
    verified: false,
  };
}

function normalizeFacts(manifest: Record<string, unknown> | undefined, diagnostics: ClaimMapDiagnostic[]): EvidenceLedgerFact[] {
  return manifestArray(manifest, ["facts"]).map((record) => normalizeFact(record, diagnostics)).filter((fact): fact is EvidenceLedgerFact => Boolean(fact)).sort((left, right) => left.factId.localeCompare(right.factId));
}

function conclusionLabelMap(manifest: Record<string, unknown> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of manifestArray(manifest, ["conclusions"])) {
    const id = boundedText(record.conclusionId ?? record.id, 180);
    const text = boundedText(record.text ?? record.summary, 220);
    if (id && text) map.set(id, text);
  }
  return map;
}

function explicitElementLabels(claimLink: EvidenceLedgerClaimLink): string[] {
  const raw = claimLink as EvidenceLedgerClaimLink & { elements?: unknown; legalElements?: unknown; elementLabels?: unknown };
  const candidates = [raw.elements, raw.legalElements, raw.elementLabels];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const labels = candidate.map((item) => {
        if (typeof item === "string") return boundedText(item, 220);
        const record = asRecord(item);
        return record ? boundedText(record.label ?? record.name ?? record.text, 220) : undefined;
      }).filter((label): label is string => Boolean(label));
      if (labels.length > 0) return labels;
    }
  }
  return [];
}

function claimLinkBelongsToGroup(link: EvidenceLedgerClaimLink, group: ClaimGroup): boolean {
  if (group.conclusionId) return link.conclusionId === group.conclusionId;
  return !link.conclusionId;
}

function factExplicitElementLabelsForGroup(fact: EvidenceLedgerFact, group: ClaimGroup): string[] {
  return uniqueSorted(fact.claimLinks.filter((link) => claimLinkBelongsToGroup(link, group)).flatMap(explicitElementLabels));
}

function factHasExplicitElementLabel(fact: EvidenceLedgerFact, group: ClaimGroup, elementLabel: string): boolean {
  return factExplicitElementLabelsForGroup(fact, group).includes(elementLabel);
}

interface ClaimGroup {
  claimId: string;
  conclusionId?: string;
  label: string;
  facts: EvidenceLedgerFact[];
  claimLinks: EvidenceLedgerClaimLink[];
  unresolvedDraftOnly: boolean;
}

function groupFacts(facts: EvidenceLedgerFact[], conclusionLabels: Map<string, string>): ClaimGroup[] {
  const groups = new Map<string, ClaimGroup>();
  let unresolvedIndex = 1;
  for (const fact of facts) {
    const upstreamLinks = fact.claimLinks.filter((link) => link.conclusionId).sort((left, right) => String(left.conclusionId).localeCompare(String(right.conclusionId)));
    const links = upstreamLinks.length > 0 ? upstreamLinks : fact.claimLinks.length > 0 ? fact.claimLinks : [{ claimLinkId: `${fact.factId}-CLM-UNRESOLVED`, factId: fact.factId, label: "Unresolved placeholder; no upstream claim link was available.", status: "unresolved-placeholder", createsClaimMap: false } satisfies EvidenceLedgerClaimLink];
    for (const link of links) {
      const key = link.conclusionId ? `conclusion:${link.conclusionId}` : `unresolved:${fact.factId}:${unresolvedIndex++}`;
      let group = groups.get(key);
      if (!group) {
        const claimId = `CM-${String(groups.size + 1).padStart(3, "0")}`;
        group = {
          claimId,
          conclusionId: link.conclusionId,
          label: link.conclusionId ? (conclusionLabels.get(link.conclusionId) ?? link.label) : `Unresolved placeholder claim group for ${fact.factId}`,
          facts: [],
          claimLinks: [],
          unresolvedDraftOnly: !link.conclusionId || link.status === "unresolved-placeholder",
        };
        groups.set(key, group);
      }
      group.facts.push(fact);
      group.claimLinks.push(link);
      if (fact.unresolvedGap || fact.confidence === "unsupported" || link.status === "unresolved-placeholder") group.unresolvedDraftOnly = true;
    }
  }
  return [...groups.values()].sort((left, right) => left.claimId.localeCompare(right.claimId));
}

function addMissingProof(target: ClaimMapMissingProof[], input: Omit<ClaimMapMissingProof, "missingProofId" | "unresolved">): string {
  const missingProofId = `MP-${String(target.length + 1).padStart(3, "0")}`;
  target.push({ missingProofId, unresolved: true, ...input });
  return missingProofId;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function buildClaimMapRows(params: { facts: EvidenceLedgerFact[]; conclusionLabels: Map<string, string>; diagnostics: ClaimMapDiagnostic[]; ledgerStatus?: string }): Omit<CounterLawsuitClaimMapResult, "runId" | "status" | "generatedAt" | "researchMemoTaskId" | "evidenceLedgerTaskId" | "claimMapTaskId" | "claimMapDocumentKey" | "statusDocumentKey" | "sourceDocuments" | "counts" | "safetyNotice"> {
  const missingProof: ClaimMapMissingProof[] = [];
  const allegations: ClaimMapAllegation[] = [];
  const supportingEvidence: ClaimMapSupportingEvidence[] = [];
  const elements: ClaimMapElement[] = [];
  const claims: ClaimMapClaim[] = [];

  for (const diagnostic of params.diagnostics) {
    if (diagnostic.severity === "info") continue;
    addMissingProof(missingProof, {
      scope: "workflow",
      severity: diagnostic.severity,
      reason: `Upstream evidence ledger diagnostic ${diagnostic.code}: ${diagnostic.message}`,
      sourceDocumentKey: diagnostic.sourceDocumentKey ?? EVIDENCE_LEDGER_DOCUMENT_KEY,
      sourceTaskId: diagnostic.sourceTaskId,
      factId: diagnostic.factId,
    });
  }

  if (params.ledgerStatus && params.ledgerStatus !== "completed") {
    addMissingProof(missingProof, {
      scope: "workflow",
      severity: params.ledgerStatus === "blocked" || params.ledgerStatus === "failed" ? "error" : "warning",
      reason: `evidence-ledger-status reports ${params.ledgerStatus}; claim map support cannot be treated as completed.`,
      sourceDocumentKey: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
    });
  }

  const groups = groupFacts(params.facts, params.conclusionLabels);
  for (const group of groups) {
    const placeholderElementLabel = "Legal element pending authority-backed extraction";
    const explicitLabels = uniqueSorted(group.claimLinks.flatMap(explicitElementLabels));
    const hasUnmappedFacts = explicitLabels.length > 0 && group.facts.some((fact) => factExplicitElementLabelsForGroup(fact, group).length === 0);
    const elementLabels = explicitLabels.length > 0 ? [...explicitLabels, ...(hasUnmappedFacts ? [placeholderElementLabel] : [])] : [placeholderElementLabel];
    const claimElementIds: string[] = [];
    const claimAllegationIds: string[] = [];
    const claimSupportIds: string[] = [];
    const claimMissingProofIds: string[] = [];

    const assignedFactIds = new Set<string>();
    for (const elementLabel of elementLabels) {
      const elementId = `EL-${String(elements.length + 1).padStart(3, "0")}`;
      const elementAllegationIds: string[] = [];
      const elementSupportIds: string[] = [];
      const elementMissingProofIds: string[] = [];
      const elementAuthorityIds: string[] = [];
      const elementCitationIds: string[] = [];
      const isPlaceholderElement = elementLabel === placeholderElementLabel;
      const factsForElement = explicitLabels.length > 0
        ? group.facts.filter((fact) => isPlaceholderElement ? factExplicitElementLabelsForGroup(fact, group).length === 0 : factHasExplicitElementLabel(fact, group, elementLabel))
        : group.facts;

      if (isPlaceholderElement) {
        const id = addMissingProof(missingProof, { scope: "element", severity: "error", reason: "Legal element pending authority-backed extraction; no upstream safe element field was available for these facts, so no legal element was invented.", claimId: group.claimId, elementId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
        elementMissingProofIds.push(id);
        claimMissingProofIds.push(id);
      }
      if (explicitLabels.length > 0 && !isPlaceholderElement && factsForElement.length === 0) {
        const id = addMissingProof(missingProof, { scope: "element", severity: "warning", reason: `Explicit upstream element ${elementLabel} has no fact-specific support mapping in the evidence ledger.`, claimId: group.claimId, elementId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
        elementMissingProofIds.push(id);
        claimMissingProofIds.push(id);
      }

      for (const fact of factsForElement) {
        assignedFactIds.add(fact.factId);
        const allegationId = `ALG-${String(allegations.length + 1).padStart(3, "0")}`;
        const supportIds: string[] = [];
        const sourceLinkIds = fact.sourceLinks.map((link) => link.sourceLinkId);
        const receiptIds = fact.sourceLinks.map((link) => link.receiptId);
        const sourcePaths = fact.sourceLinks.map((link) => link.sourcePath);
        const citationStatusIds = fact.citationStatus.map((status) => status.citationStatusId);

        for (const [supportIndex, link] of fact.sourceLinks.entries()) {
          const supportingEvidenceId = `SE-${String(supportingEvidence.length + 1).padStart(3, "0")}`;
          supportIds.push(supportingEvidenceId);
          elementSupportIds.push(supportingEvidenceId);
          claimSupportIds.push(supportingEvidenceId);
          supportingEvidence.push({
            supportingEvidenceId,
            claimId: group.claimId,
            elementId,
            allegationId,
            factId: fact.factId,
            sourceLinkId: link.sourceLinkId,
            receiptId: link.receiptId,
            sourcePath: link.sourcePath,
            citationStatusIds: fact.citationStatus.filter((status) => status.receiptId === link.receiptId || (!status.receiptId && supportIndex === 0)).map((status) => status.citationStatusId),
            verified: false,
          });
        }

        if (fact.sourceLinks.length === 0) {
          const id = addMissingProof(missingProof, { scope: "source", severity: "error", reason: `Fact ${fact.factId} has no accepted source path or receipt link.`, claimId: group.claimId, elementId, allegationId, factId: fact.factId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
          elementMissingProofIds.push(id);
          claimMissingProofIds.push(id);
        }
        if (fact.confidence === "low" || fact.confidence === "unsupported") {
          const id = addMissingProof(missingProof, { scope: "allegation", severity: fact.confidence === "unsupported" ? "error" : "warning", reason: `Fact ${fact.factId} has upstream confidence ${fact.confidence}; it remains unresolved draft support only.`, claimId: group.claimId, elementId, allegationId, factId: fact.factId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
          elementMissingProofIds.push(id);
          claimMissingProofIds.push(id);
        }
        if (fact.unresolvedGap) {
          const id = addMissingProof(missingProof, { scope: "allegation", severity: "warning", reason: `Fact ${fact.factId} is marked as an unresolved upstream ledger gap.`, claimId: group.claimId, elementId, allegationId, factId: fact.factId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
          elementMissingProofIds.push(id);
          claimMissingProofIds.push(id);
        }
        for (const diagnostic of fact.diagnostics) {
          if (diagnostic.severity === "info") continue;
          const id = addMissingProof(missingProof, { scope: "allegation", severity: diagnostic.severity, reason: `Evidence ledger diagnostic ${diagnostic.code}: ${diagnostic.message}`, claimId: group.claimId, elementId, allegationId, factId: fact.factId, sourceDocumentKey: diagnostic.sourceDocumentKey ?? EVIDENCE_LEDGER_DOCUMENT_KEY, sourceTaskId: diagnostic.sourceTaskId });
          elementMissingProofIds.push(id);
          claimMissingProofIds.push(id);
        }
        for (const status of fact.citationStatus) {
          if (status.unresolved || status.status === "unresolved-authority-lookup-record" || status.status === "missing-source-link") {
            const id = addMissingProof(missingProof, { scope: status.authorityRecordId ? "authority" : "citation", severity: status.status === "missing-source-link" ? "error" : "warning", reason: status.message, claimId: group.claimId, elementId, allegationId, factId: fact.factId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY, authorityRecordId: status.authorityRecordId, citationStatusId: status.citationStatusId });
            elementMissingProofIds.push(id);
            claimMissingProofIds.push(id);
          }
        }

        const humanId = addMissingProof(missingProof, { scope: "citation", severity: "warning", reason: "Human citation and source verification is still required; this claim-map row is not filing-ready support.", claimId: group.claimId, elementId, allegationId, factId: fact.factId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
        elementMissingProofIds.push(humanId);
        claimMissingProofIds.push(humanId);

        allegations.push({
          allegationId,
          claimId: group.claimId,
          elementId,
          factId: fact.factId,
          allegationText: fact.factText,
          supportingEvidenceIds: supportIds,
          sourceLinkIds,
          receiptIds,
          sourcePaths,
          authorityRecordIds: fact.authorityRecordIds,
          citationStatusIds,
          upstreamConfidence: fact.confidence,
          verified: false,
          unresolvedDraftOnly: group.unresolvedDraftOnly || fact.unresolvedGap || fact.confidence !== "high" || supportIds.length === 0 || fact.citationStatus.some((status) => status.unresolved),
        });
        elementAllegationIds.push(allegationId);
        claimAllegationIds.push(allegationId);
        elementAuthorityIds.push(...fact.authorityRecordIds);
        elementCitationIds.push(...citationStatusIds);
      }

      const uniqueElementMissingProofIds = uniqueSorted(elementMissingProofIds);
      elements.push({
        elementId,
        claimId: group.claimId,
        label: elementLabel,
        status: params.ledgerStatus === "blocked" || params.ledgerStatus === "failed" ? "blocked" : uniqueElementMissingProofIds.length > 0 ? "missing-proof" : "supported-draft",
        allegationIds: uniqueSorted(elementAllegationIds),
        supportingEvidenceIds: uniqueSorted(elementSupportIds),
        authorityRecordIds: uniqueSorted(elementAuthorityIds),
        citationStatusIds: uniqueSorted(elementCitationIds),
        missingProofIds: uniqueElementMissingProofIds,
        invented: false,
        verified: false,
      });
      claimElementIds.push(elementId);
    }

    if (explicitLabels.length > 0) {
      for (const fact of group.facts) {
        if (assignedFactIds.has(fact.factId)) continue;
        const id = addMissingProof(missingProof, { scope: "element", severity: "warning", reason: `Fact ${fact.factId} has no explicit upstream element mapping for claim group ${group.claimId}; it was not assigned to any legal element.`, claimId: group.claimId, factId: fact.factId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
        claimMissingProofIds.push(id);
      }
    }

    const claimMissing = uniqueSorted(claimMissingProofIds);
    claims.push({
      claimId: group.claimId,
      conclusionId: group.conclusionId,
      label: group.label,
      status: params.ledgerStatus === "blocked" || params.ledgerStatus === "failed" ? "blocked" : claimMissing.length > 0 ? "missing-proof" : "supported-draft",
      elementIds: uniqueSorted(claimElementIds),
      allegationIds: uniqueSorted(claimAllegationIds),
      supportingEvidenceIds: uniqueSorted(claimSupportIds),
      authorityRecordIds: uniqueSorted(group.facts.flatMap((fact) => fact.authorityRecordIds)),
      citationStatusIds: uniqueSorted(group.facts.flatMap((fact) => fact.citationStatus.map((status) => status.citationStatusId))),
      missingProofIds: claimMissing,
      unresolvedDraftOnly: group.unresolvedDraftOnly || claimMissing.length > 0,
      verified: false,
    });
  }

  if (claims.length === 0) {
    const claimId = "CM-001";
    const elementId = "EL-001";
    const missingProofId = addMissingProof(missingProof, { scope: "workflow", severity: "error", reason: "No safe evidence ledger facts were available to derive claim-map rows.", claimId, elementId, sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY });
    elements.push({ elementId, claimId, label: "Legal element pending authority-backed extraction", status: "blocked", allegationIds: [], supportingEvidenceIds: [], authorityRecordIds: [], citationStatusIds: [], missingProofIds: [missingProofId], invented: false, verified: false });
    claims.push({ claimId, label: "Unresolved placeholder claim group; prerequisite evidence ledger facts are missing.", status: "blocked", elementIds: [elementId], allegationIds: [], supportingEvidenceIds: [], authorityRecordIds: [], citationStatusIds: [], missingProofIds: [missingProofId], unresolvedDraftOnly: true, verified: false });
  }

  return { claims, elements, allegations, supportingEvidence, missingProof, diagnostics: params.diagnostics };
}

function ledgerStatusDiagnostic(status?: string, taskId?: string): ClaimMapDiagnostic[] {
  if (!status || status === "completed") return [];
  return [{
    code: "evidence-ledger-status-blocker",
    severity: status === "failed" || status === "blocked" ? "error" : "warning",
    message: `evidence-ledger-status reports ${status}. The claim map cannot treat the evidence ledger as completed support.`,
    sourceDocumentKey: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
    sourceTaskId: taskId,
  }];
}

function deriveStatus(params: { ledgerPresent: boolean; ledgerParsed: boolean; ledgerStatus?: string; claims: ClaimMapClaim[]; missingProof: ClaimMapMissingProof[]; diagnostics: ClaimMapDiagnostic[] }): ClaimMapStatus {
  if (!params.ledgerPresent || !params.ledgerParsed) return "blocked";
  if (params.ledgerStatus && params.ledgerStatus !== "completed") {
    if (["failed", "blocked"].includes(params.ledgerStatus)) return "blocked";
    return "partial";
  }
  if (params.claims.length === 0 || params.claims.every((claim) => claim.status === "blocked")) return "blocked";
  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "partial";
  if (params.missingProof.length > 0 || params.claims.some((claim) => claim.unresolvedDraftOnly)) return "partial";
  return "completed";
}

function countClaimMap(params: { claims: ClaimMapClaim[]; elements: ClaimMapElement[]; allegations: ClaimMapAllegation[]; supportingEvidence: ClaimMapSupportingEvidence[]; missingProof: ClaimMapMissingProof[] }): ClaimMapCounts {
  return {
    claims: params.claims.length,
    elements: params.elements.length,
    allegations: params.allegations.length,
    supportingEvidence: params.supportingEvidence.length,
    missingProof: params.missingProof.length,
    unresolvedGaps: params.missingProof.filter((proof) => proof.unresolved).length,
  };
}

export async function collectCounterLawsuitClaimMapInputs(options: CollectCounterLawsuitClaimMapInputsOptions): Promise<CounterLawsuitClaimMapResult> {
  const { researchMemoTask, evidenceLedgerTask, claimMapTask } = await locateCounterLawsuitClaimMapStageTasks({ taskStore: options.taskStore, runId: options.runId });
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const [ledger, ledgerStatus, researchMemo] = await Promise.all([
    readParsedDocument(options.taskStore, evidenceLedgerTask.id, EVIDENCE_LEDGER_DOCUMENT_KEY),
    readParsedDocument(options.taskStore, evidenceLedgerTask.id, EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY),
    researchMemoTask ? readParsedDocument(options.taskStore, researchMemoTask.id, RESEARCH_MEMO_DOCUMENT_KEY) : Promise.resolve({ document: null, source: "missing", manifest: undefined, diagnostics: [] } satisfies ParsedDocument),
  ]);
  const ledgerStatusValue = typeof ledgerStatus.manifest?.status === "string" ? ledgerStatus.manifest.status : undefined;
  const parseDiagnostics = normalizeDiagnostics(ledger.diagnostics, ledgerStatus.document ? ledgerStatus.diagnostics : [], ledgerStatusDiagnostic(ledgerStatusValue, evidenceLedgerTask.id));
  const itemDiagnostics: ClaimMapDiagnostic[] = [];
  const facts = normalizeFacts(ledger.manifest, itemDiagnostics);
  const ledgerDiagnostics = normalizeDiagnostics(manifestArray(ledger.manifest, ["diagnostics"]) as unknown as EvidenceLedgerDiagnostic[]);
  const rows = buildClaimMapRows({ facts, conclusionLabels: conclusionLabelMap(researchMemo.manifest), diagnostics: normalizeDiagnostics(parseDiagnostics, ledgerDiagnostics, itemDiagnostics), ledgerStatus: ledgerStatusValue });
  const allDiagnostics = normalizeDiagnostics(parseDiagnostics, ledgerDiagnostics, itemDiagnostics, rows.diagnostics, rows.missingProof.filter((proof) => proof.severity === "error").map((proof) => ({ code: "missing-proof", severity: proof.severity, message: proof.reason, sourceDocumentKey: proof.sourceDocumentKey, sourceTaskId: proof.sourceTaskId, claimId: proof.claimId, elementId: proof.elementId, allegationId: proof.allegationId, factId: proof.factId } satisfies ClaimMapDiagnostic)));
  const status = deriveStatus({ ledgerPresent: Boolean(ledger.document), ledgerParsed: Boolean(ledger.manifest), ledgerStatus: ledgerStatusValue, claims: rows.claims, missingProof: rows.missingProof, diagnostics: allDiagnostics });
  const sourceDocuments: ClaimMapSourceDocumentSummary[] = [
    { taskId: researchMemoTask?.id ?? "unknown", key: RESEARCH_MEMO_DOCUMENT_KEY, present: Boolean(researchMemo.document), parsedFrom: researchMemo.source, status: typeof researchMemo.manifest?.status === "string" ? researchMemo.manifest.status : undefined },
    { taskId: evidenceLedgerTask.id, key: EVIDENCE_LEDGER_DOCUMENT_KEY, present: Boolean(ledger.document), parsedFrom: ledger.source, status: typeof ledger.manifest?.status === "string" ? ledger.manifest.status : undefined },
    { taskId: evidenceLedgerTask.id, key: EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY, present: Boolean(ledgerStatus.document), parsedFrom: ledgerStatus.source, status: ledgerStatusValue },
  ];
  return {
    runId: options.runId,
    status,
    generatedAt,
    researchMemoTaskId: researchMemoTask?.id,
    evidenceLedgerTaskId: evidenceLedgerTask.id,
    claimMapTaskId: claimMapTask.id,
    claimMapDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
    statusDocumentKey: status === "completed" ? undefined : CLAIM_MAP_STATUS_DOCUMENT_KEY,
    sourceDocuments,
    claims: rows.claims,
    elements: rows.elements,
    allegations: rows.allegations,
    supportingEvidence: rows.supportingEvidence,
    missingProof: rows.missingProof,
    diagnostics: allDiagnostics,
    counts: countClaimMap(rows),
    safetyNotice: CLAIM_MAP_SAFETY_NOTICE,
  };
}

export function claimMapSummaryFromResult(result: CounterLawsuitClaimMapResult): CounterLawsuitClaimMapSummary {
  return {
    runId: result.runId,
    status: result.status,
    claimMapDocumentKey: result.claimMapDocumentKey,
    statusDocumentKey: result.statusDocumentKey,
    claimCount: result.counts.claims,
    elementCount: result.counts.elements,
    allegationCount: result.counts.allegations,
    supportingEvidenceCount: result.counts.supportingEvidence,
    missingProofCount: result.counts.missingProof,
    unresolvedGapCount: result.counts.unresolvedGaps,
    diagnostics: result.diagnostics,
    safetyNotice: result.safetyNotice,
  };
}

export function buildClaimMapManifest(result: CounterLawsuitClaimMapResult): Record<string, unknown> {
  return {
    runId: result.runId,
    generatedAt: result.generatedAt,
    status: result.status,
    sourceDocuments: result.sourceDocuments,
    researchMemoTaskId: result.researchMemoTaskId,
    evidenceLedgerTaskId: result.evidenceLedgerTaskId,
    claimMapTaskId: result.claimMapTaskId,
    claims: result.claims,
    elements: result.elements,
    allegations: result.allegations,
    supportingEvidence: result.supportingEvidence,
    missingProof: result.missingProof,
    diagnostics: result.diagnostics,
    counts: result.counts,
    safetyNotice: result.safetyNotice,
  };
}

function formatDiagnostics(diagnostics: ClaimMapDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.claimId ? ` (${diagnostic.claimId})` : ""}${diagnostic.elementId ? `/${diagnostic.elementId}` : ""}${diagnostic.allegationId ? `/${diagnostic.allegationId}` : ""}${diagnostic.factId ? ` fact ${diagnostic.factId}` : ""}${diagnostic.sourceDocumentKey ? ` [${diagnostic.sourceDocumentKey}]` : ""}: ${diagnostic.message}`).join("\n") || "- None.";
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatClaimTable(claims: ClaimMapClaim[]): string {
  const rows = claims.map((claim) => `| ${claim.claimId} | ${escapeCell(claim.label)} | ${claim.conclusionId ?? "unresolved placeholder"} | ${claim.status} | ${claim.elementIds.join(", ")} | ${claim.allegationIds.join(", ")} | ${claim.missingProofIds.join(", ") || "none"} | false |`);
  return ["| Claim ID | Label | Upstream conclusion | Status | Elements | Allegations | Missing proof | Verified |", "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function formatElementTable(elements: ClaimMapElement[]): string {
  const rows = elements.map((element) => `| ${element.elementId} | ${element.claimId} | ${escapeCell(element.label)} | ${element.status} | ${element.allegationIds.join(", ")} | ${element.supportingEvidenceIds.join(", ")} | ${element.missingProofIds.join(", ") || "none"} | false |`);
  return ["| Element ID | Claim | Label | Status | Allegations | Evidence | Missing proof | Verified |", "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function formatAllegationTable(allegations: ClaimMapAllegation[]): string {
  const rows = allegations.map((allegation) => `| ${allegation.allegationId} | ${allegation.claimId} | ${allegation.elementId} | ${allegation.factId} | ${escapeCell(allegation.allegationText)} | ${allegation.receiptIds.join(", ") || "missing receipt"} | ${allegation.sourcePaths.map(escapeCell).join("<br>") || "missing source path"} | ${allegation.authorityRecordIds.join(", ") || "none"} | ${allegation.citationStatusIds.join(", ")} | ${allegation.upstreamConfidence} | false |`);
  return ["| Allegation | Claim | Element | Fact | Text | Receipts | Source paths | Authorities | Citation statuses | Confidence | Verified |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function formatMissingProof(missingProof: ClaimMapMissingProof[]): string {
  return missingProof.map((proof) => `- ${proof.missingProofId} [${proof.severity}/${proof.scope}]${proof.claimId ? ` ${proof.claimId}` : ""}${proof.elementId ? `/${proof.elementId}` : ""}${proof.allegationId ? `/${proof.allegationId}` : ""}${proof.factId ? ` fact ${proof.factId}` : ""}: ${proof.reason}`).join("\n") || "- None recorded beyond draft-only safety limits.";
}

export function buildClaimMapMarkdown(result: CounterLawsuitClaimMapResult): string {
  const manifest = buildClaimMapManifest(result);
  return `# Counter-lawsuit claim map

${CLAIM_MAP_SAFETY_NOTICE}

This claim map preserves upstream limits: ${RESEARCH_MEMO_SAFETY_NOTICE} ${EVIDENCE_LEDGER_SAFETY_NOTICE}

## Run context

- Workflow run ID: ${result.runId}
- Research memo task ID: ${result.researchMemoTaskId ?? "unknown"}
- Evidence ledger task ID: ${result.evidenceLedgerTaskId ?? "unknown"}
- Claim map task ID: ${result.claimMapTaskId ?? "unknown"}
- Generated at: ${result.generatedAt}
- Status: ${result.status}

## Claim-map summary

- Claims: ${result.counts.claims}
- Elements: ${result.counts.elements}
- Allegations: ${result.counts.allegations}
- Supporting evidence rows: ${result.counts.supportingEvidence}
- Missing proof rows: ${result.counts.missingProof}
- Unresolved gaps: ${result.counts.unresolvedGaps}

## Claim table

${formatClaimTable(result.claims)}

## Element matrix

${formatElementTable(result.elements)}

## Allegation-to-evidence matrix

${formatAllegationTable(result.allegations)}

## Authority/citation-status appendix

${result.allegations.map((allegation) => `- ${allegation.allegationId}: authorities ${allegation.authorityRecordIds.join(", ") || "none"}; citation statuses ${allegation.citationStatusIds.join(", ") || "none"}; unresolved draft only: ${allegation.unresolvedDraftOnly}`).join("\n") || "- No allegations available."}

## Missing-proof register

${formatMissingProof(result.missingProof)}

## Diagnostics

${formatDiagnostics(result.diagnostics)}

## Machine-readable manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

function statusDocumentInput(result: CounterLawsuitClaimMapResult): { key: typeof CLAIM_MAP_STATUS_DOCUMENT_KEY; content: string; author: string; metadata: Record<string, unknown> } {
  return {
    key: CLAIM_MAP_STATUS_DOCUMENT_KEY,
    content: `# Claim map status\n\nStatus: ${result.status}\n\n${CLAIM_MAP_SAFETY_NOTICE}\n\n## Missing proof\n${formatMissingProof(result.missingProof)}\n\n## Diagnostics\n${formatDiagnostics(result.diagnostics)}\n`,
    author: "fusion-legal-claim-map",
    metadata: {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: result.runId,
      status: result.status,
      claimMapDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
      statusDocumentKey: CLAIM_MAP_STATUS_DOCUMENT_KEY,
      claimCount: result.counts.claims,
      elementCount: result.counts.elements,
      allegationCount: result.counts.allegations,
      supportingEvidenceCount: result.counts.supportingEvidence,
      missingProofCount: result.counts.missingProof,
      unresolvedGapCount: result.counts.unresolvedGaps,
      diagnostics: result.diagnostics,
      safetyNotice: CLAIM_MAP_SAFETY_NOTICE,
    },
  };
}

export async function generateCounterLawsuitClaimMap(options: GenerateCounterLawsuitClaimMapOptions): Promise<CounterLawsuitClaimMapResult> {
  const result = await collectCounterLawsuitClaimMapInputs(options);
  try {
    await options.taskStore.upsertTaskDocument(result.claimMapTaskId ?? "", {
      key: CLAIM_MAP_DOCUMENT_KEY,
      content: buildClaimMapMarkdown(result),
      author: "fusion-legal-claim-map",
      metadata: buildClaimMapManifest(result),
    });

    if (result.status !== "completed") {
      await options.taskStore.upsertTaskDocument(result.claimMapTaskId ?? "", statusDocumentInput(result));
    } else {
      const staleStatus = await options.taskStore.getTaskDocument(result.claimMapTaskId ?? "", CLAIM_MAP_STATUS_DOCUMENT_KEY).catch(() => null);
      if (staleStatus) {
        await options.taskStore.upsertTaskDocument(result.claimMapTaskId ?? "", statusDocumentInput({ ...result, statusDocumentKey: CLAIM_MAP_STATUS_DOCUMENT_KEY }));
      }
    }

    return result;
  } catch (error) {
    const failedResult: CounterLawsuitClaimMapResult = {
      ...result,
      status: "failed",
      statusDocumentKey: CLAIM_MAP_STATUS_DOCUMENT_KEY,
      diagnostics: normalizeDiagnostics(result.diagnostics, [{
        code: "claim-map-generation-failed",
        severity: "error",
        message: `Claim map generation failed: ${error instanceof Error ? error.message : String(error)}`,
        sourceDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
        sourceTaskId: result.claimMapTaskId,
      }]),
    };
    await options.taskStore.upsertTaskDocument(failedResult.claimMapTaskId ?? "", statusDocumentInput(failedResult));
    return failedResult;
  }
}

function summaryFromManifest(params: { runId: string; manifest: Record<string, unknown>; statusDocPresent: boolean }): CounterLawsuitClaimMapSummary {
  const counts = asRecord(params.manifest.counts);
  const diagnostics = manifestArray(params.manifest, ["diagnostics"]) as unknown as ClaimMapDiagnostic[];
  return {
    runId: params.runId,
    status: typeof params.manifest.status === "string" ? params.manifest.status as ClaimMapStatus : "completed",
    claimMapDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
    statusDocumentKey: params.statusDocPresent ? CLAIM_MAP_STATUS_DOCUMENT_KEY : undefined,
    claimCount: typeof counts?.claims === "number" ? counts.claims : manifestArray(params.manifest, ["claims"]).length,
    elementCount: typeof counts?.elements === "number" ? counts.elements : manifestArray(params.manifest, ["elements"]).length,
    allegationCount: typeof counts?.allegations === "number" ? counts.allegations : manifestArray(params.manifest, ["allegations"]).length,
    supportingEvidenceCount: typeof counts?.supportingEvidence === "number" ? counts.supportingEvidence : manifestArray(params.manifest, ["supportingEvidence"]).length,
    missingProofCount: typeof counts?.missingProof === "number" ? counts.missingProof : manifestArray(params.manifest, ["missingProof"]).length,
    unresolvedGapCount: typeof counts?.unresolvedGaps === "number" ? counts.unresolvedGaps : manifestArray(params.manifest, ["missingProof"]).length,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    safetyNotice: CLAIM_MAP_SAFETY_NOTICE,
  };
}

function claimMapNotRunSummary(runId: string, statusDocumentKey?: string): CounterLawsuitClaimMapSummary {
  return {
    runId,
    status: "not-run",
    claimMapDocumentKey: undefined,
    statusDocumentKey,
    claimCount: 0,
    elementCount: 0,
    allegationCount: 0,
    supportingEvidenceCount: 0,
    missingProofCount: 0,
    unresolvedGapCount: 0,
    diagnostics: [],
    safetyNotice: CLAIM_MAP_SAFETY_NOTICE,
  };
}

export async function deriveClaimMapStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<CounterLawsuitClaimMapSummary> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  const claimMapTask = findStageTask(tasks, "claim-map", CLAIM_MAP_DOCUMENT_KEY);
  if (!claimMapTask) return claimMapNotRunSummary(params.runId);
  const doc = await params.taskStore.getTaskDocument(claimMapTask.id, CLAIM_MAP_DOCUMENT_KEY).catch(() => null);
  const statusDoc = await params.taskStore.getTaskDocument(claimMapTask.id, CLAIM_MAP_STATUS_DOCUMENT_KEY).catch(() => null);
  if (statusDoc && (!doc || typeof statusDoc.metadata?.status === "string" && statusDoc.metadata.status !== "completed")) {
    const statusManifest = parseManifestFromDocument(statusDoc, CLAIM_MAP_STATUS_DOCUMENT_KEY).manifest ?? {};
    return {
      runId: params.runId,
      status: typeof statusManifest.status === "string" ? statusManifest.status as ClaimMapStatus : "failed",
      claimMapDocumentKey: doc ? CLAIM_MAP_DOCUMENT_KEY : undefined,
      statusDocumentKey: CLAIM_MAP_STATUS_DOCUMENT_KEY,
      claimCount: typeof statusManifest.claimCount === "number" ? statusManifest.claimCount : 0,
      elementCount: typeof statusManifest.elementCount === "number" ? statusManifest.elementCount : 0,
      allegationCount: typeof statusManifest.allegationCount === "number" ? statusManifest.allegationCount : 0,
      supportingEvidenceCount: typeof statusManifest.supportingEvidenceCount === "number" ? statusManifest.supportingEvidenceCount : 0,
      missingProofCount: typeof statusManifest.missingProofCount === "number" ? statusManifest.missingProofCount : 0,
      unresolvedGapCount: typeof statusManifest.unresolvedGapCount === "number" ? statusManifest.unresolvedGapCount : 0,
      diagnostics: manifestArray(statusManifest, ["diagnostics"]) as unknown as ClaimMapDiagnostic[],
      safetyNotice: CLAIM_MAP_SAFETY_NOTICE,
    };
  }
  if (!doc) return claimMapNotRunSummary(params.runId, statusDoc ? CLAIM_MAP_STATUS_DOCUMENT_KEY : undefined);
  const parsed = parseManifestFromDocument(doc, CLAIM_MAP_DOCUMENT_KEY);
  if (!parsed.manifest) {
    return {
      ...claimMapNotRunSummary(params.runId, statusDoc ? CLAIM_MAP_STATUS_DOCUMENT_KEY : undefined),
      status: "failed",
      claimMapDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
      diagnostics: parsed.diagnostics,
    };
  }
  return summaryFromManifest({ runId: params.runId, manifest: parsed.manifest, statusDocPresent: Boolean(statusDoc) });
}
