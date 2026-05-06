import type { Task, TaskDocument, TaskStore } from "@fusion/core";
import { notFound } from "./api-error.js";
import type {
  ClaimMapAllegation,
  ClaimMapClaim,
  ClaimMapDiagnosticSeverity,
  ClaimMapMissingProof,
  ClaimMapStatus,
} from "./legal-claim-map.js";

const CLAIM_MAP_DOCUMENT_KEY = "claim-map";
const CLAIM_MAP_STATUS_DOCUMENT_KEY = "claim-map-status";
const CLAIM_MAP_SAFETY_NOTICE = "Draft-only structured claim map generated from the persisted evidence ledger manifest. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.";
const COUNTER_LAWSUIT_WORKFLOW_KIND = "counter-lawsuit-prototype";

export const DRAFT_COMPLAINT_DOCUMENT_KEY = "draft-counter-lawsuit-complaint";
export const DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY = "draft-counter-lawsuit-complaint-status";
export const DRAFT_COMPLAINT_SAFETY_NOTICE = "Draft-only counter-lawsuit complaint scaffold generated from the persisted claim-map manifest. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not attorney reviewed, not filing-ready, and not promoted for filing.";

export type ComplaintDraftStatus = "completed" | "partial" | "blocked" | "failed" | "not-run";
export type ComplaintDraftDiagnosticSeverity = ClaimMapDiagnosticSeverity;

export interface ComplaintDraftDiagnostic {
  code: string;
  severity: ComplaintDraftDiagnosticSeverity;
  message: string;
  sourceDocumentKey?: string;
  sourceTaskId?: string;
  claimId?: string;
  elementId?: string;
  allegationId?: string;
  paragraphId?: string;
}

export interface ComplaintDraftSection {
  sectionId: string;
  title: string;
  status: "draft" | "placeholder" | "blocked";
  paragraphIds: string[];
  unresolvedDraftOnly: boolean;
}

export interface ComplaintDraftParagraph {
  paragraphId: string;
  paragraphNumber: number;
  text: string;
  claimId?: string;
  elementId?: string;
  allegationId?: string;
  factId?: string;
  sourcePaths: string[];
  receiptIds: string[];
  supportingEvidenceIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  verified: false;
  filingReady: false;
  unresolvedDraftOnly: boolean;
}

export interface ComplaintDraftClaim {
  claimDraftId: string;
  claimId: string;
  label: string;
  elementIds: string[];
  paragraphIds: string[];
  supportingEvidenceIds: string[];
  sourcePaths: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  missingProofIds: string[];
  verified: false;
  filingReady: false;
  unresolvedDraftOnly: boolean;
}

export interface ComplaintDraftSourceReference {
  sourceReferenceId: string;
  sourcePath: string;
  receiptIds: string[];
  claimIds: string[];
  paragraphIds: string[];
  citationStatusIds: string[];
  verified: false;
}

export interface ComplaintDraftCounts {
  sections: number;
  paragraphs: number;
  claimDrafts: number;
  sourceReferences: number;
  sourcePaths: number;
  missingProof: number;
  unresolvedGaps: number;
}

export interface CounterLawsuitComplaintDraftResult {
  runId: string;
  status: ComplaintDraftStatus;
  generatedAt: string;
  claimMapTaskId?: string;
  draftComplaintTaskId?: string;
  draftComplaintDocumentKey: typeof DRAFT_COMPLAINT_DOCUMENT_KEY;
  statusDocumentKey?: typeof DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY;
  sourceDocuments: Array<{ documentKey: string; taskId?: string; status?: string }>;
  sections: ComplaintDraftSection[];
  paragraphs: ComplaintDraftParagraph[];
  claimDrafts: ComplaintDraftClaim[];
  sourceReferences: ComplaintDraftSourceReference[];
  missingProof: ClaimMapMissingProof[];
  diagnostics: ComplaintDraftDiagnostic[];
  counts: ComplaintDraftCounts;
  safetyNotice: typeof DRAFT_COMPLAINT_SAFETY_NOTICE;
}

export interface CounterLawsuitComplaintDraftSummary {
  runId: string;
  status: ComplaintDraftStatus;
  draftComplaintDocumentKey?: typeof DRAFT_COMPLAINT_DOCUMENT_KEY | string;
  statusDocumentKey?: typeof DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY | string;
  sectionCount: number;
  paragraphCount: number;
  claimDraftCount: number;
  sourceReferenceCount: number;
  sourcePathCount: number;
  missingProofCount: number;
  unresolvedGapCount: number;
  diagnostics: ComplaintDraftDiagnostic[];
  safetyNotice: typeof DRAFT_COMPLAINT_SAFETY_NOTICE;
}

export interface GenerateCounterLawsuitComplaintDraftOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument" | "upsertTaskDocument">;
  runId: string;
  force?: boolean;
  now?: () => Date;
}

const MAX_TEXT_CHARS = 900;
const AUTH_HEADER_RE = /(["']?(?:authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^"'\n\r,}]+/gi;
const TOKEN_RE = /(?<![-A-Za-z0-9_])["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|(?<![-A-Za-z0-9_])Token\s+\S{8,}|(?:sk|pk|ghp|github_pat|obsidian)[A-Za-z0-9_:\-.=+/]{8,}/gi;
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function findStageTask(tasks: Task[], stage: string, documentKey: string): Task | undefined {
  return tasks.find((task) => task.sourceMetadata?.workflowStage === stage)
    ?? tasks.find((task) => task.sourceMetadata?.documentKey === documentKey);
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

function parseManifestFromDocument(document: TaskDocument | null, key: string): { manifest?: Record<string, unknown>; diagnostics: ComplaintDraftDiagnostic[] } {
  if (!document) {
    return {
      diagnostics: [{
        code: "draft-complaint-source-missing",
        severity: "error",
        message: `Required source document ${key} is missing.`,
        sourceDocumentKey: key,
      }],
    };
  }
  const metadataManifest = asRecord(document.metadata);
  if (metadataManifest) return { manifest: metadataManifest, diagnostics: [] };
  const blockManifest = parseJsonBlock(document.content ?? "");
  if (blockManifest) return { manifest: blockManifest, diagnostics: [] };
  return {
    diagnostics: [{
      code: "draft-complaint-manifest-malformed",
      severity: "error",
      message: `Document ${key} did not contain a readable machine manifest.`,
      sourceDocumentKey: key,
      sourceTaskId: document.taskId,
    }],
  };
}

function normalizeDiagnostic(record: Record<string, unknown>): ComplaintDraftDiagnostic {
  return {
    code: boundedText(record.code, 120) ?? "claim-map-diagnostic",
    severity: record.severity === "error" || record.severity === "warning" || record.severity === "info" ? record.severity : "warning",
    message: boundedText(record.message, 500) ?? "Upstream claim-map diagnostic carried into draft complaint generation.",
    sourceDocumentKey: boundedText(record.sourceDocumentKey, 120),
    sourceTaskId: boundedText(record.sourceTaskId, 120),
    claimId: boundedText(record.claimId, 120),
    elementId: boundedText(record.elementId, 120),
    allegationId: boundedText(record.allegationId, 120),
  };
}

function normalizeAllegation(record: Record<string, unknown>): ClaimMapAllegation {
  return {
    allegationId: boundedText(record.allegationId, 120) ?? "allegation-unknown",
    claimId: boundedText(record.claimId, 120) ?? "claim-unknown",
    elementId: boundedText(record.elementId, 120) ?? "element-unknown",
    factId: boundedText(record.factId, 120) ?? "fact-unknown",
    allegationText: boundedText(record.allegationText, 700) ?? "[Draft placeholder: upstream allegation text unavailable.]",
    supportingEvidenceIds: stringArray(record.supportingEvidenceIds),
    sourceLinkIds: stringArray(record.sourceLinkIds),
    receiptIds: stringArray(record.receiptIds),
    sourcePaths: stringArray(record.sourcePaths, 300),
    authorityRecordIds: stringArray(record.authorityRecordIds),
    citationStatusIds: stringArray(record.citationStatusIds),
    upstreamConfidence: record.upstreamConfidence === "high" || record.upstreamConfidence === "medium" || record.upstreamConfidence === "low" || record.upstreamConfidence === "unsupported" ? record.upstreamConfidence : "unsupported",
    verified: false,
    unresolvedDraftOnly: record.unresolvedDraftOnly !== false,
  };
}

function normalizeClaim(record: Record<string, unknown>): ClaimMapClaim {
  return {
    claimId: boundedText(record.claimId, 120) ?? "claim-unknown",
    conclusionId: boundedText(record.conclusionId, 120),
    label: boundedText(record.label, 240) ?? "Draft claim label unavailable",
    status: record.status === "supported-draft" || record.status === "partial-draft" || record.status === "missing-proof" || record.status === "blocked" ? record.status : "partial-draft",
    elementIds: stringArray(record.elementIds),
    allegationIds: stringArray(record.allegationIds),
    supportingEvidenceIds: stringArray(record.supportingEvidenceIds),
    authorityRecordIds: stringArray(record.authorityRecordIds),
    citationStatusIds: stringArray(record.citationStatusIds),
    missingProofIds: stringArray(record.missingProofIds),
    unresolvedDraftOnly: record.unresolvedDraftOnly !== false,
    verified: false,
  };
}

function normalizeMissingProof(record: Record<string, unknown>): ClaimMapMissingProof {
  return {
    missingProofId: boundedText(record.missingProofId, 120) ?? "missing-proof-unknown",
    scope: record.scope === "workflow" || record.scope === "claim" || record.scope === "element" || record.scope === "allegation" || record.scope === "source" || record.scope === "authority" || record.scope === "citation" ? record.scope : "workflow",
    severity: record.severity === "error" || record.severity === "warning" || record.severity === "info" ? record.severity : "warning",
    reason: boundedText(record.reason, 500) ?? "Unresolved proof gap from upstream claim map.",
    claimId: boundedText(record.claimId, 120),
    elementId: boundedText(record.elementId, 120),
    allegationId: boundedText(record.allegationId, 120),
    factId: boundedText(record.factId, 120),
    sourceDocumentKey: boundedText(record.sourceDocumentKey, 120),
    sourceTaskId: boundedText(record.sourceTaskId, 120),
    authorityRecordId: boundedText(record.authorityRecordId, 120),
    citationStatusId: boundedText(record.citationStatusId, 120),
    unresolved: true,
  };
}

function buildSections(status: ComplaintDraftStatus, paragraphs: ComplaintDraftParagraph[], missingProof: ClaimMapMissingProof[]): ComplaintDraftSection[] {
  const unresolved = status !== "completed" || missingProof.length > 0;
  return [
    { sectionId: "safety-notice", title: "Safety boundary", status: "draft", paragraphIds: [], unresolvedDraftOnly: true },
    { sectionId: "run-context", title: "Run context", status: "draft", paragraphIds: [], unresolvedDraftOnly: true },
    { sectionId: "caption-placeholder", title: "Caption placeholder", status: "placeholder", paragraphIds: [], unresolvedDraftOnly: true },
    { sectionId: "parties-jurisdiction-venue-placeholders", title: "Parties, jurisdiction, and venue placeholders", status: "placeholder", paragraphIds: [], unresolvedDraftOnly: true },
    { sectionId: "factual-allegations", title: "Numbered factual allegations", status: paragraphs.length > 0 ? "draft" : "blocked", paragraphIds: paragraphs.map((paragraph) => paragraph.paragraphId), unresolvedDraftOnly: unresolved },
    { sectionId: "draft-claims-counterclaims", title: "Draft claims or counterclaims", status: "draft", paragraphIds: [], unresolvedDraftOnly: unresolved },
    { sectionId: "requested-relief-placeholder", title: "Requested relief placeholder", status: "placeholder", paragraphIds: [], unresolvedDraftOnly: true },
    { sectionId: "source-citation-appendix", title: "Source and citation appendix", status: "draft", paragraphIds: [], unresolvedDraftOnly: unresolved },
    { sectionId: "verification-checklist", title: "Verification checklist", status: "blocked", paragraphIds: [], unresolvedDraftOnly: true },
    { sectionId: "filing-blockers", title: "Missing proof and filing blockers", status: missingProof.length > 0 ? "blocked" : "placeholder", paragraphIds: [], unresolvedDraftOnly: true },
  ];
}

function buildSourceReferences(paragraphs: ComplaintDraftParagraph[]): ComplaintDraftSourceReference[] {
  const byPath = new Map<string, ComplaintDraftSourceReference>();
  for (const paragraph of paragraphs) {
    for (const sourcePath of paragraph.sourcePaths) {
      const existing = byPath.get(sourcePath) ?? {
        sourceReferenceId: `source-ref-${byPath.size + 1}`,
        sourcePath,
        receiptIds: [],
        claimIds: [],
        paragraphIds: [],
        citationStatusIds: [],
        verified: false as const,
      };
      existing.receiptIds = uniqueSorted([...existing.receiptIds, ...paragraph.receiptIds]);
      existing.claimIds = uniqueSorted([...existing.claimIds, paragraph.claimId ?? ""]);
      existing.paragraphIds = uniqueSorted([...existing.paragraphIds, paragraph.paragraphId]);
      existing.citationStatusIds = uniqueSorted([...existing.citationStatusIds, ...paragraph.citationStatusIds]);
      byPath.set(sourcePath, existing);
    }
  }
  return [...byPath.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function buildResult(params: {
  runId: string;
  generatedAt: string;
  claimMapTask?: Task;
  draftComplaintTask?: Task;
  claimMapManifest?: Record<string, unknown>;
  diagnostics: ComplaintDraftDiagnostic[];
  claimMapStatus?: ClaimMapStatus;
}): CounterLawsuitComplaintDraftResult {
  const claims = manifestArray(params.claimMapManifest, ["claims"]).map(normalizeClaim).sort((left, right) => left.claimId.localeCompare(right.claimId));
  const allegations = manifestArray(params.claimMapManifest, ["allegations"]).map(normalizeAllegation).sort((left, right) => left.allegationId.localeCompare(right.allegationId));
  const missingProof = manifestArray(params.claimMapManifest, ["missingProof"]).map(normalizeMissingProof).sort((left, right) => left.missingProofId.localeCompare(right.missingProofId));
  const upstreamDiagnostics = manifestArray(params.claimMapManifest, ["diagnostics"]).map(normalizeDiagnostic);
  const diagnostics = [...params.diagnostics, ...upstreamDiagnostics].slice(0, 50);
  const paragraphs: ComplaintDraftParagraph[] = allegations.map((allegation, index) => ({
    paragraphId: `paragraph-${String(index + 1).padStart(3, "0")}`,
    paragraphNumber: index + 1,
    text: allegation.sourcePaths.length === 0 || allegation.receiptIds.length === 0 || allegation.supportingEvidenceIds.length === 0
      ? `BLOCKED DRAFT PARAGRAPH — source support is missing or incomplete: ${allegation.allegationText}`
      : allegation.allegationText,
    claimId: allegation.claimId,
    elementId: allegation.elementId,
    allegationId: allegation.allegationId,
    factId: allegation.factId,
    sourcePaths: uniqueSorted(allegation.sourcePaths),
    receiptIds: uniqueSorted(allegation.receiptIds),
    supportingEvidenceIds: uniqueSorted(allegation.supportingEvidenceIds),
    authorityRecordIds: uniqueSorted(allegation.authorityRecordIds),
    citationStatusIds: uniqueSorted(allegation.citationStatusIds),
    verified: false,
    filingReady: false,
    unresolvedDraftOnly: true,
  }));
  const paragraphIdsByAllegation = new Map(paragraphs.map((paragraph) => [paragraph.allegationId, paragraph.paragraphId]));
  const claimDrafts: ComplaintDraftClaim[] = claims.map((claim) => {
    const claimParagraphs = paragraphs.filter((paragraph) => paragraph.claimId === claim.claimId);
    return {
      claimDraftId: `claim-draft-${claim.claimId}`,
      claimId: claim.claimId,
      label: claim.label,
      elementIds: uniqueSorted(claim.elementIds),
      paragraphIds: uniqueSorted(claim.allegationIds.map((id) => paragraphIdsByAllegation.get(id)).filter((id): id is string => Boolean(id))),
      supportingEvidenceIds: uniqueSorted([...claim.supportingEvidenceIds, ...claimParagraphs.flatMap((paragraph) => paragraph.supportingEvidenceIds)]),
      sourcePaths: uniqueSorted(claimParagraphs.flatMap((paragraph) => paragraph.sourcePaths)),
      authorityRecordIds: uniqueSorted([...claim.authorityRecordIds, ...claimParagraphs.flatMap((paragraph) => paragraph.authorityRecordIds)]),
      citationStatusIds: uniqueSorted([...claim.citationStatusIds, ...claimParagraphs.flatMap((paragraph) => paragraph.citationStatusIds)]),
      missingProofIds: uniqueSorted(claim.missingProofIds),
      verified: false,
      filingReady: false,
      unresolvedDraftOnly: true,
    };
  });
  const sourceReferences = buildSourceReferences(paragraphs);
  const sourcePathCount = uniqueSorted(sourceReferences.map((reference) => reference.sourcePath)).length;
  let status: ComplaintDraftStatus = "completed";
  if (!params.claimMapManifest || !params.claimMapTask) status = "blocked";
  else if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) status = "failed";
  else if (params.claimMapStatus && params.claimMapStatus !== "completed") status = params.claimMapStatus === "not-run" ? "blocked" : params.claimMapStatus;
  else if (missingProof.length > 0 || paragraphs.some((paragraph) => paragraph.sourcePaths.length === 0)) status = "partial";
  const sections = buildSections(status, paragraphs, missingProof);
  const unresolvedGaps = missingProof.length + diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length + paragraphs.filter((paragraph) => paragraph.sourcePaths.length === 0).length;
  return {
    runId: params.runId,
    status,
    generatedAt: params.generatedAt,
    claimMapTaskId: params.claimMapTask?.id,
    draftComplaintTaskId: params.draftComplaintTask?.id,
    draftComplaintDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    statusDocumentKey: status !== "completed" ? DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY : undefined,
    sourceDocuments: [{ documentKey: CLAIM_MAP_DOCUMENT_KEY, taskId: params.claimMapTask?.id, status: params.claimMapStatus }],
    sections,
    paragraphs,
    claimDrafts,
    sourceReferences,
    missingProof,
    diagnostics,
    counts: {
      sections: sections.length,
      paragraphs: paragraphs.length,
      claimDrafts: claimDrafts.length,
      sourceReferences: sourceReferences.length,
      sourcePaths: sourcePathCount,
      missingProof: missingProof.length,
      unresolvedGaps,
    },
    safetyNotice: DRAFT_COMPLAINT_SAFETY_NOTICE,
  };
}

export async function locateCounterLawsuitComplaintDraftStageTasks(params: {
  taskStore: Pick<TaskStore, "listTasks">;
  runId: string;
}): Promise<{ tasks: Task[]; claimMapTask?: Task; draftComplaintTask?: Task }> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId))
    .sort((left, right) => Number(left.sourceMetadata?.workflowStageIndex ?? 0) - Number(right.sourceMetadata?.workflowStageIndex ?? 0));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  return {
    tasks,
    claimMapTask: findStageTask(tasks, "claim-map", CLAIM_MAP_DOCUMENT_KEY),
    draftComplaintTask: findStageTask(tasks, "draft-counter-lawsuit-complaint", DRAFT_COMPLAINT_DOCUMENT_KEY),
  };
}

export async function collectCounterLawsuitComplaintDraftInputs(options: GenerateCounterLawsuitComplaintDraftOptions): Promise<CounterLawsuitComplaintDraftResult> {
  const { claimMapTask, draftComplaintTask } = await locateCounterLawsuitComplaintDraftStageTasks(options);
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const diagnostics: ComplaintDraftDiagnostic[] = [];
  if (!draftComplaintTask) {
    return buildResult({
      runId: options.runId,
      generatedAt,
      claimMapTask,
      draftComplaintTask,
      diagnostics: [{
        code: "draft-complaint-stage-missing",
        severity: "error",
        message: "The workflow run has no draft-counter-lawsuit-complaint stage task. Older runs should report not-run on status and cannot be regenerated until relaunched.",
        sourceDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
      }],
    });
  }
  if (!claimMapTask) {
    return buildResult({
      runId: options.runId,
      generatedAt,
      claimMapTask,
      draftComplaintTask,
      diagnostics: [{
        code: "draft-complaint-claim-map-missing",
        severity: "error",
        message: "Complaint draft generation is blocked because the claim-map stage task is missing.",
        sourceDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
      }],
    });
  }
  const claimMapDoc = await options.taskStore.getTaskDocument(claimMapTask.id, CLAIM_MAP_DOCUMENT_KEY).catch(() => null);
  const claimMapStatusDoc = await options.taskStore.getTaskDocument(claimMapTask.id, CLAIM_MAP_STATUS_DOCUMENT_KEY).catch(() => null);
  const parsedClaimMap = parseManifestFromDocument(claimMapDoc, CLAIM_MAP_DOCUMENT_KEY);
  const statusManifest = claimMapStatusDoc ? parseManifestFromDocument(claimMapStatusDoc, CLAIM_MAP_STATUS_DOCUMENT_KEY).manifest : undefined;
  diagnostics.push(...parsedClaimMap.diagnostics);
  const claimMapStatus = typeof statusManifest?.status === "string"
    ? statusManifest.status as ClaimMapStatus
    : typeof parsedClaimMap.manifest?.status === "string" ? parsedClaimMap.manifest.status as ClaimMapStatus : undefined;
  if (claimMapStatusDoc && claimMapStatus && claimMapStatus !== "completed") {
    diagnostics.push({
      code: "draft-complaint-claim-map-unresolved",
      severity: claimMapStatus === "failed" ? "error" : "warning",
      message: `Claim map status is ${claimMapStatus}; complaint draft remains an unresolved scaffold only.`,
      sourceDocumentKey: CLAIM_MAP_STATUS_DOCUMENT_KEY,
      sourceTaskId: claimMapTask.id,
    });
  }
  return buildResult({
    runId: options.runId,
    generatedAt,
    claimMapTask,
    draftComplaintTask,
    claimMapManifest: parsedClaimMap.manifest,
    diagnostics,
    claimMapStatus,
  });
}

function buildComplaintDraftManifest(result: CounterLawsuitComplaintDraftResult): Record<string, unknown> {
  return {
    runId: result.runId,
    generatedAt: result.generatedAt,
    status: result.status,
    sourceDocuments: result.sourceDocuments,
    claimMapTaskId: result.claimMapTaskId,
    draftComplaintTaskId: result.draftComplaintTaskId,
    draftComplaintDocumentKey: result.draftComplaintDocumentKey,
    statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
    sections: result.sections,
    paragraphs: result.paragraphs,
    claimDrafts: result.claimDrafts,
    sourceReferences: result.sourceReferences,
    missingProof: result.missingProof,
    diagnostics: result.diagnostics,
    counts: result.counts,
    safetyNotice: result.safetyNotice,
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatDiagnostics(diagnostics: ComplaintDraftDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.claimId ? ` (${diagnostic.claimId})` : ""}${diagnostic.elementId ? `/${diagnostic.elementId}` : ""}${diagnostic.allegationId ? `/${diagnostic.allegationId}` : ""}${diagnostic.paragraphId ? ` paragraph ${diagnostic.paragraphId}` : ""}${diagnostic.sourceDocumentKey ? ` [${diagnostic.sourceDocumentKey}]` : ""}: ${diagnostic.message}`).join("\n") || "- None.";
}

export function buildComplaintDraftMarkdown(result: CounterLawsuitComplaintDraftResult): string {
  const manifest = buildComplaintDraftManifest(result);
  const sectionRows = result.sections.map((section) => `| ${section.sectionId} | ${escapeCell(section.title)} | ${section.status} | ${section.paragraphIds.join(", ") || "none"} | ${section.unresolvedDraftOnly} |`).join("\n");
  const paragraphRows = result.paragraphs.map((paragraph) => `| ${paragraph.paragraphNumber} | ${paragraph.paragraphId} | ${paragraph.claimId ?? "unknown"} | ${paragraph.elementId ?? "unknown"} | ${escapeCell(paragraph.text)} | ${paragraph.receiptIds.join(", ") || "missing receipt"} | ${paragraph.sourcePaths.map(escapeCell).join("<br>") || "missing source path"} | false | false |`).join("\n");
  const claimRows = result.claimDrafts.map((claim) => `| ${claim.claimDraftId} | ${claim.claimId} | ${escapeCell(claim.label)} | ${claim.elementIds.join(", ") || "unresolved"} | ${claim.paragraphIds.join(", ") || "none"} | ${claim.missingProofIds.join(", ") || "none"} | false | false |`).join("\n");
  const sourceRows = result.sourceReferences.map((source) => `| ${source.sourceReferenceId} | ${escapeCell(source.sourcePath)} | ${source.receiptIds.join(", ") || "missing receipt"} | ${source.paragraphIds.join(", ")} | ${source.citationStatusIds.join(", ") || "needs human review"} | false |`).join("\n");
  const missingProofRows = result.missingProof.map((proof) => `- ${proof.missingProofId} [${proof.severity}/${proof.scope}]${proof.claimId ? ` ${proof.claimId}` : ""}${proof.elementId ? `/${proof.elementId}` : ""}${proof.allegationId ? `/${proof.allegationId}` : ""}: ${proof.reason}`).join("\n") || "- No upstream missing-proof rows were present, but human review is still required.";
  return `# Draft counter-lawsuit complaint scaffold

${DRAFT_COMPLAINT_SAFETY_NOTICE}

This scaffold inherits the claim-map limit: ${CLAIM_MAP_SAFETY_NOTICE}

## Run context

- Workflow run ID: ${result.runId}
- Claim map task ID: ${result.claimMapTaskId ?? "unknown"}
- Draft complaint task ID: ${result.draftComplaintTaskId ?? "unknown"}
- Generated at: ${result.generatedAt}
- Status: ${result.status}

## Safety boundary

This is a pleading scaffold only. It does not verify facts, legal authority, jurisdiction, venue, parties, damages, procedure, relief, citation format, good-law status, attorney review, or filing readiness.

## Draft pleading scaffold

| Section | Title | Status | Paragraphs | Unresolved draft-only |
| --- | --- | --- | --- | --- |
${sectionRows}

## Caption placeholder

[Draft placeholder: court, caption, parties, case number, jurisdiction, venue, procedural posture, damages, and requested relief must be supplied and verified by qualified human review.]

## Numbered allegations

| No. | Paragraph ID | Claim | Element | Draft text from claim map | Receipts | Source paths | Verified | Filing ready |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${paragraphRows || "| — | — | — | — | No supported claim-map allegations available. | missing receipt | missing source path | false | false |"}

## Draft claims or counterclaims

| Draft claim | Upstream claim | Upstream label only | Elements | Paragraphs | Missing proof | Verified | Filing ready |
| --- | --- | --- | --- | --- | --- | --- | --- |
${claimRows || "| — | — | No claim-map claim rows available. | unresolved | none | claim-map missing | false | false |"}

## Source and citation appendix

| Source reference | Source path | Receipts | Paragraphs | Citation statuses | Verified |
| --- | --- | --- | --- | --- | --- |
${sourceRows || "| — | missing source path | missing receipt | none | needs human review | false |"}

## Missing-proof and filing-blocker register

${missingProofRows}

## Red-team pending note

Opposing-counsel red-team review is pending. This task does not create the FN-015 red-team report, lineage/scoring log, final citation validation, good-law verification, attorney review, or filing workflow.

## Diagnostics

${formatDiagnostics(result.diagnostics)}

## Machine-readable manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

function statusDocumentInput(result: CounterLawsuitComplaintDraftResult): { key: string; content: string; metadata: Record<string, unknown>; author: string } {
  const metadata = {
    runId: result.runId,
    status: result.status,
    draftComplaintDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
    sectionCount: result.counts.sections,
    paragraphCount: result.counts.paragraphs,
    claimDraftCount: result.counts.claimDrafts,
    sourceReferenceCount: result.counts.sourceReferences,
    sourcePathCount: result.counts.sourcePaths,
    missingProofCount: result.counts.missingProof,
    unresolvedGapCount: result.counts.unresolvedGaps,
    diagnostics: result.diagnostics,
    safetyNotice: DRAFT_COMPLAINT_SAFETY_NOTICE,
  };
  return {
    key: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
    content: `# Draft counter-lawsuit complaint status\n\nStatus: ${result.status}\n\n${DRAFT_COMPLAINT_SAFETY_NOTICE}\n\n${formatDiagnostics(result.diagnostics)}\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`,
    metadata,
    author: "fusion-legal-complaint-draft",
  };
}

export async function generateCounterLawsuitComplaintDraft(options: GenerateCounterLawsuitComplaintDraftOptions): Promise<CounterLawsuitComplaintDraftResult> {
  const result = await collectCounterLawsuitComplaintDraftInputs(options);
  const taskId = result.draftComplaintTaskId ?? "";
  try {
    await options.taskStore.upsertTaskDocument(taskId, {
      key: DRAFT_COMPLAINT_DOCUMENT_KEY,
      content: buildComplaintDraftMarkdown(result),
      author: "fusion-legal-complaint-draft",
      metadata: buildComplaintDraftManifest(result),
    });
    if (result.status !== "completed") {
      await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput(result));
    } else {
      const staleStatus = await options.taskStore.getTaskDocument(taskId, DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY).catch(() => null);
      if (staleStatus) {
        await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput({ ...result, statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY }));
      }
    }
    return result;
  } catch (error) {
    const failedResult: CounterLawsuitComplaintDraftResult = {
      ...result,
      status: "failed",
      statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
      diagnostics: [...result.diagnostics, {
        code: "draft-complaint-generation-failed",
        severity: "error",
        message: `Draft complaint generation failed: ${error instanceof Error ? boundedText(error.message, 500) : boundedText(String(error), 500)}`,
        sourceDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
        sourceTaskId: result.draftComplaintTaskId,
      }],
    };
    await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput(failedResult));
    return failedResult;
  }
}

function summaryFromManifest(params: { runId: string; manifest: Record<string, unknown>; statusDocPresent: boolean }): CounterLawsuitComplaintDraftSummary {
  const counts = asRecord(params.manifest.counts);
  const diagnostics = manifestArray(params.manifest, ["diagnostics"]).map(normalizeDiagnostic);
  return {
    runId: params.runId,
    status: typeof params.manifest.status === "string" ? params.manifest.status as ComplaintDraftStatus : "completed",
    draftComplaintDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    statusDocumentKey: params.statusDocPresent ? DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY : undefined,
    sectionCount: typeof counts?.sections === "number" ? counts.sections : manifestArray(params.manifest, ["sections"]).length,
    paragraphCount: typeof counts?.paragraphs === "number" ? counts.paragraphs : manifestArray(params.manifest, ["paragraphs"]).length,
    claimDraftCount: typeof counts?.claimDrafts === "number" ? counts.claimDrafts : manifestArray(params.manifest, ["claimDrafts"]).length,
    sourceReferenceCount: typeof counts?.sourceReferences === "number" ? counts.sourceReferences : manifestArray(params.manifest, ["sourceReferences"]).length,
    sourcePathCount: typeof counts?.sourcePaths === "number" ? counts.sourcePaths : uniqueSorted(manifestArray(params.manifest, ["sourceReferences"]).map((source) => boundedText(source.sourcePath)).filter((source): source is string => Boolean(source))).length,
    missingProofCount: typeof counts?.missingProof === "number" ? counts.missingProof : manifestArray(params.manifest, ["missingProof"]).length,
    unresolvedGapCount: typeof counts?.unresolvedGaps === "number" ? counts.unresolvedGaps : manifestArray(params.manifest, ["missingProof"]).length,
    diagnostics,
    safetyNotice: DRAFT_COMPLAINT_SAFETY_NOTICE,
  };
}

function complaintDraftNotRunSummary(runId: string, statusDocumentKey?: string): CounterLawsuitComplaintDraftSummary {
  return {
    runId,
    status: "not-run",
    draftComplaintDocumentKey: undefined,
    statusDocumentKey,
    sectionCount: 0,
    paragraphCount: 0,
    claimDraftCount: 0,
    sourceReferenceCount: 0,
    sourcePathCount: 0,
    missingProofCount: 0,
    unresolvedGapCount: 0,
    diagnostics: [],
    safetyNotice: DRAFT_COMPLAINT_SAFETY_NOTICE,
  };
}

export async function deriveComplaintDraftStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<CounterLawsuitComplaintDraftSummary> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  const draftComplaintTask = findStageTask(tasks, "draft-counter-lawsuit-complaint", DRAFT_COMPLAINT_DOCUMENT_KEY);
  if (!draftComplaintTask) return complaintDraftNotRunSummary(params.runId);
  const doc = await params.taskStore.getTaskDocument(draftComplaintTask.id, DRAFT_COMPLAINT_DOCUMENT_KEY).catch(() => null);
  const statusDoc = await params.taskStore.getTaskDocument(draftComplaintTask.id, DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY).catch(() => null);
  if (statusDoc && (!doc || typeof statusDoc.metadata?.status === "string" && statusDoc.metadata.status !== "completed")) {
    const statusManifest = parseManifestFromDocument(statusDoc, DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY).manifest ?? {};
    return {
      runId: params.runId,
      status: typeof statusManifest.status === "string" ? statusManifest.status as ComplaintDraftStatus : "failed",
      draftComplaintDocumentKey: doc ? DRAFT_COMPLAINT_DOCUMENT_KEY : undefined,
      statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
      sectionCount: typeof statusManifest.sectionCount === "number" ? statusManifest.sectionCount : 0,
      paragraphCount: typeof statusManifest.paragraphCount === "number" ? statusManifest.paragraphCount : 0,
      claimDraftCount: typeof statusManifest.claimDraftCount === "number" ? statusManifest.claimDraftCount : 0,
      sourceReferenceCount: typeof statusManifest.sourceReferenceCount === "number" ? statusManifest.sourceReferenceCount : 0,
      sourcePathCount: typeof statusManifest.sourcePathCount === "number" ? statusManifest.sourcePathCount : 0,
      missingProofCount: typeof statusManifest.missingProofCount === "number" ? statusManifest.missingProofCount : 0,
      unresolvedGapCount: typeof statusManifest.unresolvedGapCount === "number" ? statusManifest.unresolvedGapCount : 0,
      diagnostics: manifestArray(statusManifest, ["diagnostics"]).map(normalizeDiagnostic),
      safetyNotice: DRAFT_COMPLAINT_SAFETY_NOTICE,
    };
  }
  if (!doc) return complaintDraftNotRunSummary(params.runId, statusDoc ? DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY : undefined);
  const parsed = parseManifestFromDocument(doc, DRAFT_COMPLAINT_DOCUMENT_KEY);
  if (!parsed.manifest) {
    return {
      ...complaintDraftNotRunSummary(params.runId, statusDoc ? DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY : undefined),
      status: "failed",
      draftComplaintDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
      diagnostics: parsed.diagnostics,
    };
  }
  return summaryFromManifest({ runId: params.runId, manifest: parsed.manifest, statusDocPresent: Boolean(statusDoc) });
}
