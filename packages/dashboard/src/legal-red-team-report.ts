import type { Task, TaskDocument, TaskStore } from "@fusion/core";
import { notFound } from "./api-error.js";
import { CLAIM_MAP_DOCUMENT_KEY } from "./legal-claim-map.js";
import { COUNTER_LAWSUIT_WORKFLOW_KIND } from "./legal-workflow-orchestrator.js";

export const RED_TEAM_REPORT_DOCUMENT_KEY = "red-team-report";
export const RED_TEAM_REPORT_STATUS_DOCUMENT_KEY = "red-team-report-status";
export const RED_TEAM_REPORT_SAFETY_NOTICE = "Draft-only opposing-counsel red-team critique generated from the persisted draft complaint manifest. It is adversarial issue spotting only, source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not a real motion-practice decision, not filing-ready, and not promoted for filing.";

const DRAFT_COMPLAINT_DOCUMENT_KEY = "draft-counter-lawsuit-complaint";
const DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY = "draft-counter-lawsuit-complaint-status";

export type RedTeamStatus = "completed" | "partial" | "blocked" | "failed" | "stale" | "not-run";
export type RedTeamSeverity = "info" | "warning" | "high" | "blocker";
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
  sourcePaths: string[];
  authorityRecordIds: string[];
  citationStatusIds: string[];
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
  authorityRecordIds: string[];
  citationStatusIds: string[];
  sourcePaths: string[];
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
  const status = deriveStatus({
    redTeamStagePresent: Boolean(redTeamTask),
    complaintTaskPresent: Boolean(draftComplaintTask),
    complaintPresent: Boolean(complaint.document),
    complaintParsed: Boolean(complaint.manifest),
    complaintStatus: complaintStatusValue,
    diagnostics,
  });
  const counts = countsFromComplaintManifest(complaint.manifest);
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
    findings: [],
    mtdAttacks: [],
    citationIssues: [],
    revisionRecommendations: [],
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

function summaryFromManifest(params: { runId: string; manifest: Record<string, unknown>; statusDocPresent: boolean }): CounterLawsuitRedTeamReportSummary {
  const counts = asRecord(params.manifest.counts);
  const diagnostics = normalizeDiagnostics(manifestArray(params.manifest, ["diagnostics"]).map((record) => ({
    code: boundedText(record.code, 180) ?? "diagnostic",
    severity: record.severity === "error" || record.severity === "warning" || record.severity === "info" ? record.severity : "warning",
    message: boundedText(record.message, 500) ?? "Red-team diagnostic requires review.",
    sourceDocumentKey: boundedText(record.sourceDocumentKey, 180),
    sourceTaskId: boundedText(record.sourceTaskId, 180),
    paragraphId: boundedText(record.paragraphId, 180),
    claimDraftId: boundedText(record.claimDraftId, 180),
    findingId: boundedText(record.findingId, 180),
  })));
  return {
    runId: params.runId,
    status: typeof params.manifest.status === "string" ? params.manifest.status as RedTeamStatus : "completed",
    redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY,
    statusDocumentKey: params.statusDocPresent ? RED_TEAM_REPORT_STATUS_DOCUMENT_KEY : undefined,
    findingCount: typeof counts?.findings === "number" ? counts.findings : manifestArray(params.manifest, ["findings"]).length,
    mtdAttackCount: typeof counts?.mtdAttacks === "number" ? counts.mtdAttacks : manifestArray(params.manifest, ["mtdAttacks"]).length,
    citationIssueCount: typeof counts?.citationIssues === "number" ? counts.citationIssues : manifestArray(params.manifest, ["citationIssues"]).length,
    revisionRecommendationCount: typeof counts?.revisionRecommendations === "number" ? counts.revisionRecommendations : manifestArray(params.manifest, ["revisionRecommendations"]).length,
    unresolvedBlockerCount: typeof counts?.unresolvedBlockers === "number" ? counts.unresolvedBlockers : 0,
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
      status: typeof statusManifest.status === "string" ? statusManifest.status as RedTeamStatus : "failed",
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
