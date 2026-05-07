import type { Task, TaskDocument, TaskStore } from "@fusion/core";
import { notFound } from "./api-error.js";
import { CLAIM_MAP_DOCUMENT_KEY } from "./legal-claim-map.js";
import {
  DRAFT_COMPLAINT_DOCUMENT_KEY,
  DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
} from "./legal-complaint-draft.js";
import { COUNTER_LAWSUIT_WORKFLOW_KIND } from "./legal-workflow-orchestrator.js";

export const RED_TEAM_REPORT_DOCUMENT_KEY = "red-team-report";
export const RED_TEAM_REPORT_STATUS_DOCUMENT_KEY = "red-team-report-status";
export const RED_TEAM_REPORT_SAFETY_NOTICE = "Draft-only opposing-counsel red-team critique generated from the persisted draft complaint manifest. It is adversarial issue spotting only, source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not a real motion-practice decision, not filing-ready, and not promoted for filing.";

export type RedTeamStatus = "completed" | "partial" | "blocked" | "failed" | "stale" | "not-run";
export type RedTeamSeverity = "info" | "warning" | "high" | "blocker";

const RED_TEAM_STATUSES = new Set<RedTeamStatus>(["completed", "partial", "blocked", "failed", "stale", "not-run"]);

function isRedTeamStatus(value: unknown): value is RedTeamStatus {
  return typeof value === "string" && RED_TEAM_STATUSES.has(value as RedTeamStatus);
}
export type RedTeamFindingCategory =
  | "pleading-weakness"
  | "motion-to-dismiss-risk"
  | "citation-source-issue"
  | "missing-proof"
  | "placeholder-field"
  | "unresolved-authority"
  | "draft-only-safety"
  | "upstream-blocker";
export type RedTeamDiagnosticSeverity = "info" | "warning" | "error";

export interface RedTeamDiagnostic {
  code: string;
  severity: RedTeamDiagnosticSeverity;
  message: string;
  sourceDocumentKey?: string;
  sourceTaskId?: string;
  paragraphId?: string;
  claimDraftId?: string;
  findingId?: string;
}

export interface RedTeamFinding {
  findingId: string;
  category: RedTeamFindingCategory;
  severity: RedTeamSeverity;
  summary: string;
  paragraphIds: string[];
  claimDraftIds: string[];
  missingProofIds: string[];
  sourceReferenceIds: string[];
  sourcePaths: string[];
  receiptIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  sourceTaskIds: string[];
  unresolved: true;
}

export interface RedTeamMotionToDismissAttack {
  attackId: string;
  category: string;
  severity: RedTeamSeverity;
  summary: string;
  paragraphIds: string[];
  claimDraftIds: string[];
  missingProofIds: string[];
  sourceReferenceIds: string[];
  sourcePaths: string[];
  receiptIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  sourceTaskIds: string[];
  draftRiskOnly: true;
}

export interface RedTeamCitationIssue {
  issueId: string;
  severity: RedTeamSeverity;
  summary: string;
  paragraphIds: string[];
  claimDraftIds: string[];
  sourceReferenceIds: string[];
  sourcePaths: string[];
  receiptIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  humanVerificationRequired: true;
}

export interface RedTeamRevisionRecommendation {
  recommendationId: string;
  findingIds: string[];
  summary: string;
  paragraphIds: string[];
  claimDraftIds: string[];
  missingProofIds: string[];
  sourceReferenceIds: string[];
  sourcePaths: string[];
  receiptIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  sourceTaskIds: string[];
  unresolved: true;
}

export interface RedTeamCounts {
  findings: number;
  mtdAttacks: number;
  citationIssues: number;
  revisionRecommendations: number;
  unresolvedBlockers: number;
  reviewedParagraphs: number;
  reviewedClaims: number;
  sourceReferences: number;
  sourcePaths: number;
}

export interface RedTeamSourceDocumentSummary {
  taskId: string;
  key: string;
  present: boolean;
  parsedFrom?: "metadata" | "json-block" | "missing" | "malformed";
  status?: string;
}

export interface CounterLawsuitRedTeamReportResult {
  runId: string;
  status: RedTeamStatus;
  generatedAt: string;
  claimMapTaskId?: string;
  draftComplaintTaskId?: string;
  redTeamTaskId?: string;
  draftComplaintDocumentKey?: typeof DRAFT_COMPLAINT_DOCUMENT_KEY;
  redTeamReportDocumentKey: typeof RED_TEAM_REPORT_DOCUMENT_KEY;
  statusDocumentKey?: typeof RED_TEAM_REPORT_STATUS_DOCUMENT_KEY;
  sourceDocuments: RedTeamSourceDocumentSummary[];
  findings: RedTeamFinding[];
  mtdAttacks: RedTeamMotionToDismissAttack[];
  citationIssues: RedTeamCitationIssue[];
  revisionRecommendations: RedTeamRevisionRecommendation[];
  diagnostics: RedTeamDiagnostic[];
  counts: RedTeamCounts;
  safetyNotice: typeof RED_TEAM_REPORT_SAFETY_NOTICE;
}

export interface CounterLawsuitRedTeamReportSummary {
  runId: string;
  status: RedTeamStatus;
  redTeamReportDocumentKey?: typeof RED_TEAM_REPORT_DOCUMENT_KEY | string;
  statusDocumentKey?: typeof RED_TEAM_REPORT_STATUS_DOCUMENT_KEY | string;
  findingCount: number;
  mtdAttackCount: number;
  citationIssueCount: number;
  revisionRecommendationCount: number;
  unresolvedBlockerCount: number;
  reviewedParagraphCount: number;
  reviewedClaimCount: number;
  diagnostics: RedTeamDiagnostic[];
  safetyNotice: typeof RED_TEAM_REPORT_SAFETY_NOTICE;
}

export interface CollectCounterLawsuitRedTeamInputsOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
  now?: () => Date;
}

export interface GenerateCounterLawsuitRedTeamReportOptions {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument" | "upsertTaskDocument">;
  runId: string;
  force?: boolean;
  now?: () => Date;
}

interface ParsedDocument {
  document: TaskDocument | null;
  source: RedTeamSourceDocumentSummary["parsedFrom"];
  manifest?: Record<string, unknown>;
  diagnostics: RedTeamDiagnostic[];
}

const MAX_TEXT_CHARS = 900;
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
  return value.map((item) => boundedText(item, maxChars)).filter((item): item is string => Boolean(item)).sort();
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function findStageTask(tasks: Task[], stage: string, documentKey: string): Task | undefined {
  return tasks.find((task) => task.sourceMetadata?.workflowStage === stage)
    ?? tasks.find((task) => task.sourceMetadata?.documentKey === documentKey);
}

export async function locateCounterLawsuitRedTeamStageTasks(params: {
  taskStore: Pick<TaskStore, "listTasks">;
  runId: string;
}): Promise<{ tasks: Task[]; claimMapTask?: Task; draftComplaintTask?: Task; redTeamTask?: Task }> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId))
    .sort((left, right) => {
      const leftIndex = Number(left.sourceMetadata?.workflowStageIndex ?? Number.MAX_SAFE_INTEGER);
      const rightIndex = Number(right.sourceMetadata?.workflowStageIndex ?? Number.MAX_SAFE_INTEGER);
      return leftIndex - rightIndex || left.id.localeCompare(right.id);
    });
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  return {
    tasks,
    claimMapTask: findStageTask(tasks, "claim-map", CLAIM_MAP_DOCUMENT_KEY),
    draftComplaintTask: findStageTask(tasks, "draft-counter-lawsuit-complaint", DRAFT_COMPLAINT_DOCUMENT_KEY),
    redTeamTask: findStageTask(tasks, "opposing-counsel-red-team-report", RED_TEAM_REPORT_DOCUMENT_KEY),
  };
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

function normalizeDiagnostics(...diagnosticGroups: Array<Array<RedTeamDiagnostic> | undefined>): RedTeamDiagnostic[] {
  const result: RedTeamDiagnostic[] = [];
  for (const group of diagnosticGroups) {
    for (const diagnostic of group ?? []) {
      result.push({
        code: boundedText(diagnostic.code, 180) ?? "diagnostic",
        severity: diagnostic.severity === "error" || diagnostic.severity === "warning" || diagnostic.severity === "info" ? diagnostic.severity : "warning",
        message: boundedText(diagnostic.message, 500) ?? boundedText(diagnostic.code, 180) ?? "diagnostic",
        sourceDocumentKey: boundedText(diagnostic.sourceDocumentKey, 180),
        sourceTaskId: boundedText(diagnostic.sourceTaskId, 180),
        paragraphId: boundedText(diagnostic.paragraphId, 180),
        claimDraftId: boundedText(diagnostic.claimDraftId, 180),
        findingId: boundedText(diagnostic.findingId, 180),
      });
    }
  }
  return result.slice(0, MAX_DIAGNOSTICS);
}

function normalizeManifestDiagnostics(manifest: Record<string, unknown> | undefined): RedTeamDiagnostic[] {
  return manifestArray(manifest, ["diagnostics"]).map((record) => ({
    code: boundedText(record.code, 180) ?? "upstream-diagnostic",
    severity: record.severity === "error" || record.severity === "warning" || record.severity === "info" ? record.severity : "warning",
    message: boundedText(record.message, 500) ?? "Upstream draft complaint diagnostic requires review.",
    sourceDocumentKey: boundedText(record.sourceDocumentKey, 180) ?? DRAFT_COMPLAINT_DOCUMENT_KEY,
    sourceTaskId: boundedText(record.sourceTaskId, 180),
    paragraphId: boundedText(record.paragraphId, 180),
    claimDraftId: boundedText(record.claimDraftId, 180),
  }));
}

function statusFromManifest(manifest: Record<string, unknown> | undefined): string | undefined {
  return boundedText(manifest?.status, 80);
}

function statusDiagnostic(status: string | undefined, taskId: string | undefined): RedTeamDiagnostic[] {
  if (!status || status === "completed") return [];
  return [{
    code: "draft-complaint-status-blocker",
    severity: status === "failed" || status === "blocked" ? "error" : "warning",
    message: `${DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY} reports ${status}. The red-team report cannot treat the draft complaint as completed support.`,
    sourceDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
    sourceTaskId: taskId,
  }];
}

function deriveStatus(params: { redTeamStagePresent: boolean; complaintTaskPresent: boolean; complaintPresent: boolean; complaintParsed: boolean; complaintStatus?: string; diagnostics: RedTeamDiagnostic[] }): RedTeamStatus {
  if (!params.redTeamStagePresent) return "not-run";
  if (!params.complaintTaskPresent || !params.complaintPresent || !params.complaintParsed) return "blocked";
  if (params.complaintStatus && params.complaintStatus !== "completed") {
    if (params.complaintStatus === "failed" || params.complaintStatus === "blocked") return "blocked";
    if (params.complaintStatus === "stale") return "stale";
    return "partial";
  }
  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "partial";
  return "partial";
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function countsFromComplaintManifest(manifest: Record<string, unknown> | undefined): RedTeamCounts {
  const counts = asRecord(manifest?.counts);
  const paragraphs = manifestArray(manifest, ["paragraphs"]);
  const claimDrafts = manifestArray(manifest, ["claimDrafts", "claims"]);
  const sourceReferences = manifestArray(manifest, ["sourceReferences"]);
  const sourcePaths = uniqueSorted([
    ...paragraphs.flatMap((record) => stringArray(record.sourcePaths, 500)),
    ...claimDrafts.flatMap((record) => stringArray(record.sourcePaths, 500)),
    ...sourceReferences.map((record) => boundedText(record.sourcePath, 500)),
  ]);
  return {
    findings: 0,
    mtdAttacks: 0,
    citationIssues: 0,
    revisionRecommendations: 0,
    unresolvedBlockers: typeof counts?.unresolvedGaps === "number" ? counts.unresolvedGaps : manifestArray(manifest, ["missingProof"]).length,
    reviewedParagraphs: typeof counts?.paragraphs === "number" ? counts.paragraphs : paragraphs.length,
    reviewedClaims: typeof counts?.claimDrafts === "number" ? counts.claimDrafts : claimDrafts.length,
    sourceReferences: typeof counts?.sourceReferences === "number" ? counts.sourceReferences : sourceReferences.length,
    sourcePaths: sourcePaths.length,
  };
}


interface RedTeamRefs {
  paragraphIds: string[];
  claimDraftIds: string[];
  missingProofIds: string[];
  sourceReferenceIds: string[];
  sourcePaths: string[];
  receiptIds: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
  sourceTaskIds: string[];
}

interface RedTeamRows {
  findings: RedTeamFinding[];
  mtdAttacks: RedTeamMotionToDismissAttack[];
  citationIssues: RedTeamCitationIssue[];
  revisionRecommendations: RedTeamRevisionRecommendation[];
}

function compactText(record: Record<string, unknown>, keys: string[], maxChars = 500): string | undefined {
  for (const key of keys) {
    const value = boundedText(record[key], maxChars);
    if (value) return value;
  }
  return undefined;
}

function refArray(record: Record<string, unknown>, arrayKey: string, singleKey: string, maxChars = 180): string[] {
  return uniqueSorted([...stringArray(record[arrayKey], maxChars), boundedText(record[singleKey], maxChars)]);
}

function refs(record: Record<string, unknown>, extra: Partial<RedTeamRefs> = {}): RedTeamRefs {
  return {
    paragraphIds: uniqueSorted([...refArray(record, "paragraphIds", "paragraphId"), ...(extra.paragraphIds ?? [])]),
    claimDraftIds: uniqueSorted([...refArray(record, "claimDraftIds", "claimDraftId"), boundedText(record.claimId), ...(extra.claimDraftIds ?? [])]),
    missingProofIds: uniqueSorted([...refArray(record, "missingProofIds", "missingProofId"), ...(extra.missingProofIds ?? [])]),
    sourceReferenceIds: uniqueSorted([...refArray(record, "sourceReferenceIds", "sourceReferenceId"), ...(extra.sourceReferenceIds ?? [])]),
    sourcePaths: uniqueSorted([...refArray(record, "sourcePaths", "sourcePath", 500), ...(extra.sourcePaths ?? [])]),
    receiptIds: uniqueSorted([...refArray(record, "receiptIds", "receiptId"), ...(extra.receiptIds ?? [])]),
    authorityRecordIds: uniqueSorted([...refArray(record, "authorityRecordIds", "authorityRecordId"), boundedText(record.authorityId), ...(extra.authorityRecordIds ?? [])]),
    citationStatusIds: uniqueSorted([...refArray(record, "citationStatusIds", "citationStatusId"), ...(extra.citationStatusIds ?? [])]),
    sourceTaskIds: uniqueSorted([...refArray(record, "sourceTaskIds", "sourceTaskId"), boundedText(record.taskId), ...(extra.sourceTaskIds ?? [])]),
  };
}

function mergeRefSets(...sets: Array<Partial<RedTeamRefs> | undefined>): RedTeamRefs {
  return {
    paragraphIds: uniqueSorted(sets.flatMap((set) => set?.paragraphIds ?? [])),
    claimDraftIds: uniqueSorted(sets.flatMap((set) => set?.claimDraftIds ?? [])),
    missingProofIds: uniqueSorted(sets.flatMap((set) => set?.missingProofIds ?? [])),
    sourceReferenceIds: uniqueSorted(sets.flatMap((set) => set?.sourceReferenceIds ?? [])),
    sourcePaths: uniqueSorted(sets.flatMap((set) => set?.sourcePaths ?? [])),
    receiptIds: uniqueSorted(sets.flatMap((set) => set?.receiptIds ?? [])),
    authorityRecordIds: uniqueSorted(sets.flatMap((set) => set?.authorityRecordIds ?? [])),
    citationStatusIds: uniqueSorted(sets.flatMap((set) => set?.citationStatusIds ?? [])),
    sourceTaskIds: uniqueSorted(sets.flatMap((set) => set?.sourceTaskIds ?? [])),
  };
}

function lowerIncludes(value: string | undefined, needles: string[]): boolean {
  const lower = (value ?? "").toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function recordHasAnyText(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Boolean(boundedText(record[key], 500) ?? stringArray(record[key], 500)[0]));
}

function hasCourtListenerMatch(record: Record<string, unknown>): boolean {
  return recordHasAnyText(record, ["matchedUrl", "matchedUrls", "courtListenerUrl", "courtListenerUrls", "courtListenerMatchedUrl", "courtListenerMatchedUrls", "absoluteUrl", "absoluteUrls"]);
}

function sortedRecords(manifest: Record<string, unknown> | undefined, keys: string[], idKeys: string[]): Array<Record<string, unknown>> {
  return manifestArray(manifest, keys).sort((left, right) => {
    const leftId = idKeys.map((key) => boundedText(left[key])).find(Boolean) ?? "";
    const rightId = idKeys.map((key) => boundedText(right[key])).find(Boolean) ?? "";
    return leftId.localeCompare(rightId);
  });
}

function complaintSourceTaskIds(manifest: Record<string, unknown> | undefined): string[] {
  return uniqueSorted([
    boundedText(manifest?.draftComplaintTaskId),
    ...manifestArray(manifest, ["sourceDocuments"]).map((record) => boundedText(record.taskId)),
  ]);
}

function makeRedTeamRows(manifest: Record<string, unknown> | undefined, diagnostics: RedTeamDiagnostic[], complaintStatus?: string): RedTeamRows {
  if (!manifest) return { findings: [], mtdAttacks: [], citationIssues: [], revisionRecommendations: [] };
  const sourceTaskIds = complaintSourceTaskIds(manifest);
  const defaults = { sourceTaskIds };
  const sections = sortedRecords(manifest, ["sections"], ["sectionId", "id"]);
  const paragraphs = sortedRecords(manifest, ["paragraphs"], ["paragraphId", "id"]);
  const claims = sortedRecords(manifest, ["claimDrafts", "claims"], ["claimDraftId", "claimId", "id"]);
  const missing = sortedRecords(manifest, ["missingProof"], ["missingProofId", "id"]);
  const sources = sortedRecords(manifest, ["sourceReferences"], ["sourceReferenceId", "id"]);
  const findings: RedTeamFinding[] = [];
  const citationIssues: RedTeamCitationIssue[] = [];
  const addFinding = (category: RedTeamFindingCategory, severity: RedTeamSeverity, summary: string, refInput?: Partial<RedTeamRefs>): RedTeamFinding => {
    const merged = mergeRefSets(refInput, defaults);
    const finding = { findingId: `RTF-${String(findings.length + 1).padStart(3, "0")}`, category, severity, summary: boundedText(summary, 500) ?? "Draft-only finding requires review.", ...merged, unresolved: true as const };
    findings.push(finding);
    return finding;
  };
  const addCitationIssue = (severity: RedTeamSeverity, summary: string, refInput?: Partial<RedTeamRefs>): void => {
    const merged = mergeRefSets(refInput, defaults);
    citationIssues.push({ issueId: `RTCI-${String(citationIssues.length + 1).padStart(3, "0")}`, severity, summary: boundedText(summary, 500) ?? "Citation issue requires human review.", paragraphIds: merged.paragraphIds, claimDraftIds: merged.claimDraftIds, sourceReferenceIds: merged.sourceReferenceIds, sourcePaths: merged.sourcePaths, receiptIds: merged.receiptIds, authorityRecordIds: merged.authorityRecordIds, citationStatusIds: merged.citationStatusIds, humanVerificationRequired: true });
  };
  const textOf = (record: Record<string, unknown>): string | undefined => compactText(record, ["reason", "summary", "description", "title", "heading", "text", "body", "content"], 500);
  const proofRefs = (needles: string[]): RedTeamRefs[] => missing.filter((record) => lowerIncludes(textOf(record), needles)).map((record) => refs(record, defaults));
  const placeholderRefs = (needles: string[]): RedTeamRefs[] => [
    ...sections.filter((record) => lowerIncludes(textOf(record), ["placeholder", ...needles]) && lowerIncludes(textOf(record), needles)).map((record) => refs(record, defaults)),
    ...proofRefs(["placeholder", ...needles]),
  ];

  if (complaintStatus && complaintStatus !== "completed") addFinding("upstream-blocker", complaintStatus === "blocked" || complaintStatus === "failed" ? "blocker" : "high", `${DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY} reports ${complaintStatus}; inherited blockers remain unresolved.`, { sourceTaskIds });
  for (const diagnostic of diagnostics.filter((item) => item.severity === "error")) addFinding("upstream-blocker", "blocker", diagnostic.message, { paragraphIds: uniqueSorted([diagnostic.paragraphId]), claimDraftIds: uniqueSorted([diagnostic.claimDraftId]), sourceTaskIds: uniqueSorted([diagnostic.sourceTaskId, ...sourceTaskIds]) });
  for (const record of missing) {
    const proofRefsForRow = refs(record, defaults);
    const reason = textOf(record) ?? proofRefsForRow.missingProofIds[0] ?? "upstream missing-proof row";
    addFinding("missing-proof", lowerIncludes(reason, ["jurisdiction", "venue", "standing", "damages", "relief", "element"]) ? "high" : "warning", `Missing proof remains unresolved: ${reason}.`, proofRefsForRow);
  }
  const placeholderTopics: Array<[string, string[], RedTeamSeverity]> = [
    ["caption, parties, standing, or capacity placeholders remain unresolved", ["caption", "party", "parties", "standing", "capacity"], "high"],
    ["jurisdiction or venue placeholders remain unresolved", ["jurisdiction", "venue"], "blocker"],
    ["damages, requested relief, or remedy placeholders remain unresolved", ["damages", "relief", "remedy"], "high"],
  ];
  for (const [summary, needles, severity] of placeholderTopics) {
    const matches = placeholderRefs(needles);
    if (matches.length > 0) addFinding("placeholder-field", severity, summary, mergeRefSets(...matches));
  }
  for (const record of paragraphs) {
    const rowRefs = refs(record, defaults);
    const text = textOf(record);
    const blocked = record.blocked === true || record.unsupported === true || record.unresolvedDraftOnly === true || lowerIncludes(text, ["placeholder", "tbd", "unknown"]);
    if (blocked || rowRefs.sourcePaths.length === 0 || rowRefs.receiptIds.length === 0) addFinding("pleading-weakness", rowRefs.sourcePaths.length === 0 || rowRefs.receiptIds.length === 0 ? "high" : "warning", `Draft paragraph ${rowRefs.paragraphIds[0] ?? "unknown"} is unsupported, blocked, or draft-only unresolved.`, rowRefs);
    if (rowRefs.sourcePaths.length === 0 || rowRefs.receiptIds.length === 0) addCitationIssue(rowRefs.sourcePaths.length === 0 ? "high" : "warning", `Draft paragraph ${rowRefs.paragraphIds[0] ?? "unknown"} lacks a source path or receipt ID.`, rowRefs);
  }
  for (const record of claims) {
    const rowRefs = refs(record, defaults);
    const elementIds = stringArray(record.elementIds);
    const supportIds = uniqueSorted([...stringArray(record.supportIds), ...stringArray(record.supportingEvidenceIds)]);
    const blocked = record.blocked === true || record.unsupported === true || record.unresolvedDraftOnly === true || elementIds.length === 0 || supportIds.length === 0;
    if (blocked || rowRefs.sourcePaths.length === 0 || rowRefs.receiptIds.length === 0) addFinding("pleading-weakness", elementIds.length === 0 || supportIds.length === 0 ? "high" : "warning", `Draft claim ${rowRefs.claimDraftIds[0] ?? "unknown"} has unresolved element, support, source, or receipt gaps.`, rowRefs);
    if (supportIds.length === 0 || rowRefs.sourcePaths.length === 0 || rowRefs.receiptIds.length === 0) addCitationIssue(rowRefs.sourcePaths.length === 0 || supportIds.length === 0 ? "high" : "warning", `Draft claim ${rowRefs.claimDraftIds[0] ?? "unknown"} lacks source-linked support or a receipt ID.`, rowRefs);
  }
  const sourceAuthorityIdsWithCourtListenerMatch = new Set(sources.filter(hasCourtListenerMatch).flatMap((record) => refs(record, defaults).authorityRecordIds));
  for (const record of sources) {
    const rowRefs = refs(record, defaults);
    const statusText = compactText(record, ["status", "citationStatus", "authorityStatus", "lookupStatus", "matchStatus", "humanVerificationStatus"], 240);
    const matchedUrl = hasCourtListenerMatch(record);
    if (rowRefs.sourcePaths.length === 0 || rowRefs.receiptIds.length === 0) {
      addFinding("citation-source-issue", rowRefs.sourcePaths.length === 0 ? "high" : "warning", `Source reference ${rowRefs.sourceReferenceIds[0] ?? "unknown"} is missing a source path or receipt ID.`, rowRefs);
      addCitationIssue(rowRefs.sourcePaths.length === 0 ? "high" : "warning", `Source reference ${rowRefs.sourceReferenceIds[0] ?? "unknown"} must be repaired with a source path and receipt ID before use.`, rowRefs);
    }
    if (rowRefs.authorityRecordIds.length > 0 && (!matchedUrl || lowerIncludes(statusText, ["unmatched", "ambiguous", "unavailable", "not-found", "human", "review"]))) {
      addFinding("unresolved-authority", "warning", `Authority lookup for source reference ${rowRefs.sourceReferenceIds[0] ?? "unknown"} is unresolved or needs human review.`, rowRefs);
      addCitationIssue("warning", "Authority record IDs require human review before any citation use.", rowRefs);
    }
  }
  const authoritySupportWithoutCourtListenerMatch = mergeRefSets(
    ...[...paragraphs, ...claims]
      .map((record) => refs(record, defaults))
      .filter((rowRefs) => rowRefs.authorityRecordIds.some((authorityRecordId) => !sourceAuthorityIdsWithCourtListenerMatch.has(authorityRecordId))),
  );
  if (authoritySupportWithoutCourtListenerMatch.authorityRecordIds.length > 0) {
    addFinding("unresolved-authority", "warning", "Authority record IDs used as draft support lack a CourtListener matched URL in the complaint manifest and require human review.", authoritySupportWithoutCourtListenerMatch);
    addCitationIssue("warning", "Authority support lacks a CourtListener matched URL; preserve as unresolved until human citation/source review.", authoritySupportWithoutCourtListenerMatch);
  }
  const citationRefs = mergeRefSets(...[...paragraphs, ...claims, ...sources].map((record) => refs(record, defaults)).filter((rowRefs) => rowRefs.citationStatusIds.length > 0));
  if (citationRefs.citationStatusIds.length > 0) {
    addFinding("citation-source-issue", "warning", "Citation-status IDs in the draft complaint still require human citation-format and source verification.", citationRefs);
    addCitationIssue("warning", "Citation-status IDs are lookup/status records only and require human verification before reliance.", citationRefs);
  }
  if (proofRefs(["damages", "relief", "remedy", "support"]).length > 0) addFinding("pleading-weakness", "high", "Damages, requested relief, or support gaps remain unresolved in upstream missing-proof rows.", mergeRefSets(...proofRefs(["damages", "relief", "remedy", "support"])));
  addFinding("draft-only-safety", "info", "The draft complaint and this red-team report remain draft-only, unverified, not legal advice, not citation-format validation, and not filing-ready.", { sourceTaskIds });

  const addAttack = (attacks: RedTeamMotionToDismissAttack[], category: string, severity: RedTeamSeverity, attackRefs: Partial<RedTeamRefs>): void => {
    if (attacks.some((attack) => attack.category === category)) return;
    const merged = mergeRefSets(attackRefs, defaults);
    attacks.push({ attackId: `RTM-${String(attacks.length + 1).padStart(3, "0")}`, category, severity, summary: `Draft risk category only: ${category.replace(/-/g, " ")} requires attorney review and is not a real motion-practice decision.`, ...merged, draftRiskOnly: true });
  };
  const attacks: RedTeamMotionToDismissAttack[] = [];
  const missingElement = mergeRefSets(...proofRefs(["element", "support", "proof", "unsupported"]), ...claims.filter((record) => stringArray(record.elementIds).length === 0 || stringArray(record.supportIds).length + stringArray(record.supportingEvidenceIds).length === 0).map((record) => refs(record, defaults)));
  const jurisdictionVenueMatches = placeholderRefs(["jurisdiction", "venue"]);
  const standingMatches = placeholderRefs(["standing", "capacity", "party", "parties", "caption"]);
  const damagesMatches = placeholderRefs(["damages", "relief", "remedy"]);
  const jurisdictionVenue = mergeRefSets(...jurisdictionVenueMatches);
  const standing = mergeRefSets(...standingMatches);
  const timeliness = mergeRefSets(...proofRefs(["limitations", "timeliness", "deadline", "date", "time"]));
  const damages = mergeRefSets(...damagesMatches);
  const preclusion = mergeRefSets(...proofRefs(["preclusion", "immunity"]));
  const specificity = mergeRefSets(...paragraphs.filter((record) => refs(record, defaults).sourcePaths.length === 0 || lowerIncludes(textOf(record), ["placeholder", "tbd", "unknown", "conclusory"])).map((record) => refs(record, defaults)), ...proofRefs(["specificity", "conclusory", "facts", "factual"]));
  if (missingElement.missingProofIds.length + missingElement.claimDraftIds.length > 0 || findings.some((finding) => finding.category === "pleading-weakness")) addAttack(attacks, "failure-to-state-a-claim", "high", missingElement);
  if (missingElement.missingProofIds.length + missingElement.claimDraftIds.length > 0) addAttack(attacks, "missing-element-support", "high", missingElement);
  if (standingMatches.length > 0) addAttack(attacks, "standing-or-capacity-gap", "high", standing);
  if (jurisdictionVenueMatches.length > 0) addAttack(attacks, "jurisdiction-or-venue-gap", "blocker", jurisdictionVenue);
  if (timeliness.missingProofIds.length > 0) addAttack(attacks, "limitations-or-timeliness-gap", "warning", timeliness);
  if (damagesMatches.length > 0) addAttack(attacks, "damages-or-relief-gap", "high", damages);
  if (preclusion.missingProofIds.length > 0) addAttack(attacks, "preclusion-or-immunity-gap", "warning", preclusion);
  if (specificity.paragraphIds.length + specificity.missingProofIds.length > 0) addAttack(attacks, "insufficient-factual-specificity", "high", specificity);

  const recommendationSummary = (finding: RedTeamFinding): string => {
    if (finding.category === "citation-source-issue" || finding.category === "unresolved-authority") return "Obtain human citation/source review, preserve citation and authority IDs, add source-linked support, or keep the issue unresolved.";
    if (finding.category === "placeholder-field") return "Confirm jurisdiction, venue, standing, parties, damages, and requested relief facts with source-linked support before any further draft use.";
    if (finding.category === "missing-proof") return "Add source support for the missing-proof row, mark unsupported allegations unresolved, or split the claim theory for attorney review.";
    if (finding.category === "pleading-weakness" || finding.category === "motion-to-dismiss-risk") return "Narrow or remove the affected draft paragraph or claim, add source support, and split any claim theory that needs attorney review.";
    return "Narrow, remove, or mark the affected draft-only material unresolved until source-linked support and human review are available.";
  };
  const revisionRecommendations = findings.map((finding, index) => ({ recommendationId: `RTR-${String(index + 1).padStart(3, "0")}`, findingIds: [finding.findingId], summary: recommendationSummary(finding), paragraphIds: finding.paragraphIds, claimDraftIds: finding.claimDraftIds, missingProofIds: finding.missingProofIds, sourceReferenceIds: finding.sourceReferenceIds, sourcePaths: finding.sourcePaths, receiptIds: finding.receiptIds, authorityRecordIds: finding.authorityRecordIds, citationStatusIds: finding.citationStatusIds, sourceTaskIds: finding.sourceTaskIds, unresolved: true as const }));
  return { findings, mtdAttacks: attacks, citationIssues, revisionRecommendations };
}

function countsWithRows(base: RedTeamCounts, rows: RedTeamRows): RedTeamCounts {
  return { ...base, findings: rows.findings.length, mtdAttacks: rows.mtdAttacks.length, citationIssues: rows.citationIssues.length, revisionRecommendations: rows.revisionRecommendations.length, unresolvedBlockers: Math.max(base.unresolvedBlockers, rows.findings.filter((finding) => finding.severity === "blocker").length) };
}

function statusWithRows(baseStatus: RedTeamStatus, rows: RedTeamRows): RedTeamStatus {
  if (baseStatus === "not-run" || baseStatus === "blocked" || baseStatus === "failed" || baseStatus === "stale") return baseStatus;
  return rows.findings.length > 0 || rows.mtdAttacks.length > 0 || rows.citationIssues.length > 0 ? "partial" : "completed";
}

function sourceDocuments(params: {
  claimMapTask?: Task;
  draftComplaintTask?: Task;
  complaint: ParsedDocument;
  complaintStatus: ParsedDocument;
}): RedTeamSourceDocumentSummary[] {
  return [
    { taskId: params.claimMapTask?.id ?? "unknown", key: CLAIM_MAP_DOCUMENT_KEY, present: Boolean(params.claimMapTask), parsedFrom: params.claimMapTask ? undefined : "missing" },
    { taskId: params.draftComplaintTask?.id ?? "unknown", key: DRAFT_COMPLAINT_DOCUMENT_KEY, present: Boolean(params.complaint.document), parsedFrom: params.complaint.source, status: statusFromManifest(params.complaint.manifest) },
    { taskId: params.draftComplaintTask?.id ?? "unknown", key: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY, present: Boolean(params.complaintStatus.document), parsedFrom: params.complaintStatus.source, status: statusFromManifest(params.complaintStatus.manifest) },
  ];
}

export async function collectCounterLawsuitRedTeamInputs(options: CollectCounterLawsuitRedTeamInputsOptions): Promise<CounterLawsuitRedTeamReportResult> {
  const { claimMapTask, draftComplaintTask, redTeamTask } = await locateCounterLawsuitRedTeamStageTasks({ taskStore: options.taskStore, runId: options.runId });
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const missingStageDiagnostics: RedTeamDiagnostic[] = [];
  if (!draftComplaintTask) {
    missingStageDiagnostics.push({
      code: "missing-draft-complaint-stage",
      severity: "error",
      message: "Legal workflow run has no draft-counter-lawsuit-complaint stage task for red-team input collection.",
      sourceDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    });
  }
  const [complaint, complaintStatus] = draftComplaintTask
    ? await Promise.all([
      readParsedDocument(options.taskStore, draftComplaintTask.id, DRAFT_COMPLAINT_DOCUMENT_KEY),
      readParsedDocument(options.taskStore, draftComplaintTask.id, DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY),
    ])
    : [
      { document: null, source: "missing", manifest: undefined, diagnostics: [] } satisfies ParsedDocument,
      { document: null, source: "missing", manifest: undefined, diagnostics: [] } satisfies ParsedDocument,
    ];
  const complaintStatusValue = statusFromManifest(complaintStatus.manifest);
  const diagnostics = normalizeDiagnostics(
    missingStageDiagnostics,
    complaint.diagnostics,
    complaintStatus.document ? complaintStatus.diagnostics : [],
    normalizeManifestDiagnostics(complaint.manifest),
    normalizeManifestDiagnostics(complaintStatus.manifest),
    statusDiagnostic(complaintStatusValue, draftComplaintTask?.id),
  );
  const baseStatus = deriveStatus({
    redTeamStagePresent: Boolean(redTeamTask),
    complaintTaskPresent: Boolean(draftComplaintTask),
    complaintPresent: Boolean(complaint.document),
    complaintParsed: Boolean(complaint.manifest),
    complaintStatus: complaintStatusValue,
    diagnostics,
  });
  const rows = makeRedTeamRows(complaint.manifest, diagnostics, complaintStatusValue);
  const status = statusWithRows(baseStatus, rows);
  const counts = countsWithRows(countsFromComplaintManifest(complaint.manifest), rows);
  const effectiveStatusDocumentKey = status === "completed" || status === "not-run" ? undefined : RED_TEAM_REPORT_STATUS_DOCUMENT_KEY;
  return {
    runId: options.runId,
    status,
    generatedAt,
    claimMapTaskId: claimMapTask?.id,
    draftComplaintTaskId: draftComplaintTask?.id,
    redTeamTaskId: redTeamTask?.id,
    draftComplaintDocumentKey: draftComplaintTask ? DRAFT_COMPLAINT_DOCUMENT_KEY : undefined,
    redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
    statusDocumentKey: effectiveStatusDocumentKey,
    sourceDocuments: sourceDocuments({ claimMapTask, draftComplaintTask, complaint, complaintStatus }),
    findings: rows.findings,
    mtdAttacks: rows.mtdAttacks,
    citationIssues: rows.citationIssues,
    revisionRecommendations: rows.revisionRecommendations,
    diagnostics,
    counts,
    safetyNotice: RED_TEAM_REPORT_SAFETY_NOTICE,
  };
}

export function redTeamSummaryFromResult(result: CounterLawsuitRedTeamReportResult): CounterLawsuitRedTeamReportSummary {
  return {
    runId: result.runId,
    status: result.status,
    redTeamReportDocumentKey: result.status === "not-run" ? undefined : result.redTeamReportDocumentKey,
    statusDocumentKey: result.statusDocumentKey,
    findingCount: result.counts.findings,
    mtdAttackCount: result.counts.mtdAttacks,
    citationIssueCount: result.counts.citationIssues,
    revisionRecommendationCount: result.counts.revisionRecommendations,
    unresolvedBlockerCount: result.counts.unresolvedBlockers,
    reviewedParagraphCount: result.counts.reviewedParagraphs,
    reviewedClaimCount: result.counts.reviewedClaims,
    diagnostics: result.diagnostics,
    safetyNotice: result.safetyNotice,
  };
}

function buildRedTeamReportManifest(result: CounterLawsuitRedTeamReportResult): Record<string, unknown> {
  return {
    runId: result.runId,
    generatedAt: result.generatedAt,
    status: result.status,
    claimMapTaskId: result.claimMapTaskId,
    draftComplaintTaskId: result.draftComplaintTaskId,
    redTeamTaskId: result.redTeamTaskId,
    draftComplaintDocumentKey: result.draftComplaintDocumentKey,
    redTeamReportDocumentKey: result.redTeamReportDocumentKey,
    statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
    sourceDocuments: result.sourceDocuments,
    findings: result.findings,
    mtdAttacks: result.mtdAttacks,
    citationIssues: result.citationIssues,
    revisionRecommendations: result.revisionRecommendations,
    diagnostics: result.diagnostics,
    counts: result.counts,
    safetyNotice: result.safetyNotice,
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatDiagnostics(diagnostics: RedTeamDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.findingId ? ` (${diagnostic.findingId})` : ""}${diagnostic.claimDraftId ? ` claim ${diagnostic.claimDraftId}` : ""}${diagnostic.paragraphId ? ` paragraph ${diagnostic.paragraphId}` : ""}${diagnostic.sourceDocumentKey ? ` [${diagnostic.sourceDocumentKey}]` : ""}: ${diagnostic.message}`).join("\n") || "- None.";
}

function formatList(values: string[], empty = "none"): string {
  return values.length > 0 ? values.map(escapeCell).join(", ") : empty;
}

function paragraphAndClaimCritiqueRows(result: CounterLawsuitRedTeamReportResult): string {
  const paragraphIds = uniqueSorted([
    ...result.findings.flatMap((finding) => finding.paragraphIds),
    ...result.mtdAttacks.flatMap((attack) => attack.paragraphIds),
    ...result.citationIssues.flatMap((issue) => issue.paragraphIds),
  ]);
  const claimDraftIds = uniqueSorted([
    ...result.findings.flatMap((finding) => finding.claimDraftIds),
    ...result.mtdAttacks.flatMap((attack) => attack.claimDraftIds),
    ...result.citationIssues.flatMap((issue) => issue.claimDraftIds),
  ]);
  const rows = [
    ...paragraphIds.map((paragraphId) => {
      const relatedFindings = result.findings.filter((finding) => finding.paragraphIds.includes(paragraphId));
      const relatedIssues = result.citationIssues.filter((issue) => issue.paragraphIds.includes(paragraphId));
      return `| paragraph | ${escapeCell(paragraphId)} | ${formatList(relatedFindings.map((finding) => finding.findingId))} | ${formatList(relatedIssues.map((issue) => issue.issueId))} | Draft-only critique: preserve source links, do not treat this as verified fact or filing-ready text. |`;
    }),
    ...claimDraftIds.map((claimDraftId) => {
      const relatedFindings = result.findings.filter((finding) => finding.claimDraftIds.includes(claimDraftId));
      const relatedAttacks = result.mtdAttacks.filter((attack) => attack.claimDraftIds.includes(claimDraftId));
      return `| claim draft | ${escapeCell(claimDraftId)} | ${formatList(relatedFindings.map((finding) => finding.findingId))} | ${formatList(relatedAttacks.map((attack) => attack.attackId))} | Draft-only critique: narrow, remove, or keep unresolved unless source-linked support and human review are available. |`;
    }),
  ];
  return rows.join("\n") || "| draft scope | unavailable | none | none | No paragraph or claim critique can be completed without a reviewable draft complaint manifest. |";
}

function unresolvedBlockerRows(result: CounterLawsuitRedTeamReportResult): string {
  const blockers = result.findings.filter((finding) => finding.severity === "blocker" || finding.category === "upstream-blocker");
  const diagnosticBlockers = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const rows = [
    ...blockers.map((finding) => `| finding | ${finding.findingId} | ${finding.severity} | ${escapeCell(finding.summary)} | ${formatList([...finding.paragraphIds, ...finding.claimDraftIds, ...finding.missingProofIds])} | true |`),
    ...diagnosticBlockers.map((diagnostic) => `| diagnostic | ${escapeCell(diagnostic.code)} | ${diagnostic.severity} | ${escapeCell(diagnostic.message)} | ${formatList(uniqueSorted([diagnostic.paragraphId, diagnostic.claimDraftId, diagnostic.sourceDocumentKey]))} | true |`),
  ];
  return rows.join("\n") || "| none | none | info | No blocker rows were generated; human review remains required before any reliance. | none | true |";
}

export function buildRedTeamReportMarkdown(result: CounterLawsuitRedTeamReportResult): string {
  const manifest = buildRedTeamReportManifest(result);
  const findingRows = result.findings.map((finding) => `| ${finding.findingId} | ${finding.category} | ${finding.severity} | ${escapeCell(finding.summary)} | ${finding.paragraphIds.join(", ") || "none"} | ${finding.claimDraftIds.join(", ") || "none"} | ${finding.sourcePaths.map(escapeCell).join("<br>") || "missing source path"} | true |`).join("\n");
  const attackRows = result.mtdAttacks.map((attack) => `| ${attack.attackId} | ${attack.category} | ${attack.severity} | ${escapeCell(attack.summary)} | ${attack.paragraphIds.join(", ") || "none"} | ${attack.claimDraftIds.join(", ") || "none"} | true |`).join("\n");
  const citationRows = result.citationIssues.map((issue) => `| ${issue.issueId} | ${issue.severity} | ${escapeCell(issue.summary)} | ${issue.sourcePaths.map(escapeCell).join("<br>") || "missing source path"} | ${issue.receiptIds.join(", ") || "missing receipt"} | ${issue.authorityRecordIds.join(", ") || "none"} | ${issue.citationStatusIds.join(", ") || "none"} | true |`).join("\n");
  const revisionRows = result.revisionRecommendations.map((recommendation) => `| ${recommendation.recommendationId} | ${recommendation.findingIds.join(", ") || "none"} | ${escapeCell(recommendation.summary)} | ${recommendation.paragraphIds.join(", ") || "none"} | ${recommendation.claimDraftIds.join(", ") || "none"} | true |`).join("\n");
  return `# Opposing-counsel red-team report

${RED_TEAM_REPORT_SAFETY_NOTICE}

## Safety boundary

This is an adversarial issue-spotting artifact only. It does not verify facts, law, good-law status, citation format, attorney judgment, real motion practice, filing readiness, or blocker resolution.

## Run context

- Workflow run ID: ${result.runId}
- Claim map task ID: ${result.claimMapTaskId ?? "unknown"}
- Draft complaint task ID: ${result.draftComplaintTaskId ?? "unknown"}
- Red-team task ID: ${result.redTeamTaskId ?? "unknown"}
- Generated at: ${result.generatedAt}
- Status: ${result.status}
- Red-team report document key: ${result.redTeamReportDocumentKey}
- Status document key: ${result.statusDocumentKey ?? RED_TEAM_REPORT_STATUS_DOCUMENT_KEY}

## Executive risk summary

- Findings: ${result.counts.findings}
- Candidate motion-to-dismiss risk rows: ${result.counts.mtdAttacks}
- Citation/source issues: ${result.counts.citationIssues}
- Revision recommendations: ${result.counts.revisionRecommendations}
- Unresolved blockers: ${result.counts.unresolvedBlockers}
- Reviewed paragraphs: ${result.counts.reviewedParagraphs}
- Reviewed claims: ${result.counts.reviewedClaims}
- Source references: ${result.counts.sourceReferences}
- Source paths: ${result.counts.sourcePaths}
- Overall posture: ${result.status === "completed" ? "No generated blocker rows, but still draft-only and human-review required." : "Unresolved or incomplete; do not treat as verified, filing-ready, or legal advice."}

## Weakness table

| Finding | Category | Severity | Summary | Paragraphs | Draft claims | Source paths | Unresolved |
| --- | --- | --- | --- | --- | --- | --- | --- |
${findingRows || "| — | upstream-blocker | blocker | No reviewable draft complaint manifest was available. | none | none | missing source path | true |"}

## Motion-to-dismiss risk matrix

| Attack | Category | Severity | Draft-risk-only summary | Paragraphs | Draft claims | Draft risk only |
| --- | --- | --- | --- | --- | --- | --- |
${attackRows || "| — | unavailable | blocker | No candidate MTD attack rows can be generated without a reviewable draft complaint manifest. | none | none | true |"}

## Citation/source issue register

| Issue | Severity | Summary | Source paths | Receipts | Authority records | Citation statuses | Human verification required |
| --- | --- | --- | --- | --- | --- | --- | --- |
${citationRows || "| — | warning | No citation issue rows were generated, but human citation and source review remains required. | missing source path | missing receipt | none | none | true |"}

## Paragraph and claim critique

| Scope | ID | Related findings | Related risks/issues | Critique boundary |
| --- | --- | --- | --- | --- |
${paragraphAndClaimCritiqueRows(result)}

## Revision recommendations

| Recommendation | Findings | Summary | Paragraphs | Draft claims | Unresolved |
| --- | --- | --- | --- | --- | --- |
${revisionRows || "| — | none | Keep the report unresolved until a source-linked draft complaint exists and qualified human review is available. | none | none | true |"}

## Unresolved blockers

| Source | ID/code | Severity | Summary | References | Unresolved |
| --- | --- | --- | --- | --- | --- |
${unresolvedBlockerRows(result)}

## Diagnostics

${formatDiagnostics(result.diagnostics)}

## Machine-readable JSON manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

function statusDocumentInput(result: CounterLawsuitRedTeamReportResult): { key: string; content: string; metadata: Record<string, unknown>; author: string } {
  const metadata = {
    runId: result.runId,
    status: result.status,
    redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
    statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
    findingCount: result.counts.findings,
    mtdAttackCount: result.counts.mtdAttacks,
    citationIssueCount: result.counts.citationIssues,
    revisionRecommendationCount: result.counts.revisionRecommendations,
    unresolvedBlockerCount: result.counts.unresolvedBlockers,
    reviewedParagraphCount: result.counts.reviewedParagraphs,
    reviewedClaimCount: result.counts.reviewedClaims,
    diagnostics: result.diagnostics,
    safetyNotice: RED_TEAM_REPORT_SAFETY_NOTICE,
  };
  return {
    key: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
    content: `# Opposing-counsel red-team report status\n\nStatus: ${result.status}\n\n${RED_TEAM_REPORT_SAFETY_NOTICE}\n\n${formatDiagnostics(result.diagnostics)}\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`,
    metadata,
    author: "fusion-legal-red-team-report",
  };
}

export async function generateCounterLawsuitRedTeamReport(options: GenerateCounterLawsuitRedTeamReportOptions): Promise<CounterLawsuitRedTeamReportResult> {
  void options.force;
  const result = await collectCounterLawsuitRedTeamInputs(options);
  const taskId = result.redTeamTaskId;
  if (!taskId) return result;
  try {
    await options.taskStore.upsertTaskDocument(taskId, {
      key: RED_TEAM_REPORT_DOCUMENT_KEY,
      content: buildRedTeamReportMarkdown(result),
      author: "fusion-legal-red-team-report",
      metadata: buildRedTeamReportManifest(result),
    });
    if (result.status !== "completed") {
      await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput(result));
    } else {
      const staleStatus = await options.taskStore.getTaskDocument(taskId, RED_TEAM_REPORT_STATUS_DOCUMENT_KEY).catch(() => null);
      if (staleStatus) await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput({ ...result, statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY }));
    }
    return result;
  } catch (error) {
    const failedResult: CounterLawsuitRedTeamReportResult = {
      ...result,
      status: "failed",
      statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
      diagnostics: [...result.diagnostics, {
        code: "red-team-report-generation-failed",
        severity: "error",
        message: `Red-team report generation failed: ${error instanceof Error ? boundedText(error.message, 500) : boundedText(String(error), 500)}`,
        sourceDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
        sourceTaskId: taskId,
      }],
    };
    await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput(failedResult));
    return failedResult;
  }
}

function summaryFromManifest(params: { runId: string; manifest: Record<string, unknown>; statusDocPresent: boolean }): CounterLawsuitRedTeamReportSummary {
  const counts = asRecord(params.manifest.counts);
  const manifestStatus = isRedTeamStatus(params.manifest.status) ? params.manifest.status : undefined;
  const malformedStatus = !manifestStatus;
  const diagnostics = normalizeDiagnostics([
    ...manifestArray(params.manifest, ["diagnostics"]).map((record) => ({
      code: boundedText(record.code, 180) ?? "diagnostic",
      severity: (record.severity === "error" || record.severity === "warning" || record.severity === "info" ? record.severity : "warning") as RedTeamDiagnostic["severity"],
      message: boundedText(record.message, 500) ?? "Red-team diagnostic requires review.",
      sourceDocumentKey: boundedText(record.sourceDocumentKey, 180),
      sourceTaskId: boundedText(record.sourceTaskId, 180),
      paragraphId: boundedText(record.paragraphId, 180),
      claimDraftId: boundedText(record.claimDraftId, 180),
      findingId: boundedText(record.findingId, 180),
    })),
    ...(malformedStatus ? [{
      code: "malformed-manifest",
      severity: "error" as const,
      message: "Red-team report manifest is missing a valid status; treating the persisted report as failed instead of completed.",
      sourceDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
    }] : []),
  ]);
  const unresolvedBlockerCount = typeof counts?.unresolvedBlockers === "number" ? counts.unresolvedBlockers : 0;
  return {
    runId: params.runId,
    status: manifestStatus ?? "failed",
    redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
    statusDocumentKey: params.statusDocPresent ? RED_TEAM_REPORT_STATUS_DOCUMENT_KEY : undefined,
    findingCount: typeof counts?.findings === "number" ? counts.findings : manifestArray(params.manifest, ["findings"]).length,
    mtdAttackCount: typeof counts?.mtdAttacks === "number" ? counts.mtdAttacks : manifestArray(params.manifest, ["mtdAttacks"]).length,
    citationIssueCount: typeof counts?.citationIssues === "number" ? counts.citationIssues : manifestArray(params.manifest, ["citationIssues"]).length,
    revisionRecommendationCount: typeof counts?.revisionRecommendations === "number" ? counts.revisionRecommendations : manifestArray(params.manifest, ["revisionRecommendations"]).length,
    unresolvedBlockerCount: malformedStatus ? Math.max(unresolvedBlockerCount, 1) : unresolvedBlockerCount,
    reviewedParagraphCount: typeof counts?.reviewedParagraphs === "number" ? counts.reviewedParagraphs : 0,
    reviewedClaimCount: typeof counts?.reviewedClaims === "number" ? counts.reviewedClaims : 0,
    diagnostics,
    safetyNotice: RED_TEAM_REPORT_SAFETY_NOTICE,
  };
}

function notRunSummary(runId: string, statusDocumentKey?: string): CounterLawsuitRedTeamReportSummary {
  return {
    runId,
    status: "not-run",
    redTeamReportDocumentKey: undefined,
    statusDocumentKey,
    findingCount: 0,
    mtdAttackCount: 0,
    citationIssueCount: 0,
    revisionRecommendationCount: 0,
    unresolvedBlockerCount: 0,
    reviewedParagraphCount: 0,
    reviewedClaimCount: 0,
    diagnostics: [],
    safetyNotice: RED_TEAM_REPORT_SAFETY_NOTICE,
  };
}

export async function deriveRedTeamReportStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<CounterLawsuitRedTeamReportSummary> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, params.runId));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);
  const redTeamTask = findStageTask(tasks, "opposing-counsel-red-team-report", RED_TEAM_REPORT_DOCUMENT_KEY);
  if (!redTeamTask) return notRunSummary(params.runId);
  const doc = await params.taskStore.getTaskDocument(redTeamTask.id, RED_TEAM_REPORT_DOCUMENT_KEY).catch(() => null);
  const statusDoc = await params.taskStore.getTaskDocument(redTeamTask.id, RED_TEAM_REPORT_STATUS_DOCUMENT_KEY).catch(() => null);
  if (statusDoc && (!doc || typeof statusDoc.metadata?.status === "string" && statusDoc.metadata.status !== "completed")) {
    const statusManifest = parseManifestFromDocument(statusDoc, RED_TEAM_REPORT_STATUS_DOCUMENT_KEY).manifest ?? {};
    return {
      ...notRunSummary(params.runId, RED_TEAM_REPORT_STATUS_DOCUMENT_KEY),
      status: isRedTeamStatus(statusManifest.status) ? statusManifest.status : "failed",
      redTeamReportDocumentKey: doc ? RED_TEAM_REPORT_DOCUMENT_KEY : undefined,
      findingCount: typeof statusManifest.findingCount === "number" ? statusManifest.findingCount : 0,
      mtdAttackCount: typeof statusManifest.mtdAttackCount === "number" ? statusManifest.mtdAttackCount : 0,
      citationIssueCount: typeof statusManifest.citationIssueCount === "number" ? statusManifest.citationIssueCount : 0,
      revisionRecommendationCount: typeof statusManifest.revisionRecommendationCount === "number" ? statusManifest.revisionRecommendationCount : 0,
      unresolvedBlockerCount: typeof statusManifest.unresolvedBlockerCount === "number" ? statusManifest.unresolvedBlockerCount : 0,
      reviewedParagraphCount: typeof statusManifest.reviewedParagraphCount === "number" ? statusManifest.reviewedParagraphCount : 0,
      reviewedClaimCount: typeof statusManifest.reviewedClaimCount === "number" ? statusManifest.reviewedClaimCount : 0,
      diagnostics: normalizeDiagnostics(manifestArray(statusManifest, ["diagnostics"]).map((record) => ({
        code: boundedText(record.code, 180) ?? "diagnostic",
        severity: record.severity === "error" || record.severity === "warning" || record.severity === "info" ? record.severity : "warning",
        message: boundedText(record.message, 500) ?? "Red-team status diagnostic requires review.",
        sourceDocumentKey: boundedText(record.sourceDocumentKey, 180),
        sourceTaskId: boundedText(record.sourceTaskId, 180),
      }))),
    };
  }
  if (!doc) return notRunSummary(params.runId, statusDoc ? RED_TEAM_REPORT_STATUS_DOCUMENT_KEY : undefined);
  const parsed = parseManifestFromDocument(doc, RED_TEAM_REPORT_DOCUMENT_KEY);
  if (!parsed.manifest) {
    return {
      ...notRunSummary(params.runId, statusDoc ? RED_TEAM_REPORT_STATUS_DOCUMENT_KEY : undefined),
      status: "failed",
      redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
      diagnostics: parsed.diagnostics,
    };
  }
  return summaryFromManifest({ runId: params.runId, manifest: parsed.manifest, statusDocPresent: Boolean(statusDoc) });
}
