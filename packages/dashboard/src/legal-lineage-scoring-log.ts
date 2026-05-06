import { createHash } from "node:crypto";
import type { Task, TaskDocument, TaskDocumentRevision, TaskStore, WorkflowStep } from "@fusion/core";
import { notFound } from "./api-error.js";
import {
  CLAIM_MAP_DOCUMENT_KEY,
  CLAIM_MAP_STATUS_DOCUMENT_KEY,
} from "./legal-claim-map.js";
import {
  DRAFT_COMPLAINT_DOCUMENT_KEY,
  DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
} from "./legal-complaint-draft.js";
import {
  EVIDENCE_LEDGER_DOCUMENT_KEY,
  EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
} from "./legal-evidence-ledger.js";
import {
  RED_TEAM_REPORT_DOCUMENT_KEY,
  RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
} from "./legal-red-team-report.js";
import {
  RESEARCH_MEMO_DOCUMENT_KEY,
  RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
} from "./legal-research-memo.js";
import {
  COUNTER_LAWSUIT_RUN_DOCUMENT_KEY,
  COUNTER_LAWSUIT_STAGE_DEFINITIONS,
  COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY,
  COUNTER_LAWSUIT_WORKFLOW_KIND,
} from "./legal-workflow-orchestrator.js";

export const LINEAGE_SCORING_LOG_DOCUMENT_KEY = "lineage-scoring-log";
export const LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY = "lineage-scoring-log-status";
export const LINEAGE_SCORING_LOG_SAFETY_NOTICE = "Lineage and scoring entries are workflow diagnostics only. They are not legal advice, not legal verification, not artifact promotion, not reliability certification, not filing-readiness review, and not a substitute for qualified human legal, source, citation, and good-law review.";

export type LineageStatus = "completed" | "partial" | "blocked" | "failed" | "stale" | "not-run";
export type LineageDiagnosticSeverity = "info" | "warning" | "error";
export type LineageManifestSource = "metadata" | "json-block" | "missing" | "malformed";

export interface LineageDiagnostic {
  code: string;
  severity: LineageDiagnosticSeverity;
  message: string;
  sourceTaskId?: string;
  sourceDocumentKey?: string;
  workflowStage?: string;
}

export interface LineageSourceTrace {
  traceId: string;
  taskId: string;
  workflowStage?: string;
  documentKey: string;
  present: boolean;
  parsedFrom: LineageManifestSource;
  status?: string;
  revision?: number;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  contentHash?: string;
  metadataSummary?: Record<string, unknown>;
  excerpt?: string;
  revisionCount: number;
}

export interface LineagePromptTrace {
  traceId: string;
  sourceType: "stage-task" | "stage-document" | "run-document" | "workflow-step";
  taskId?: string;
  workflowStage?: string;
  documentKey?: string;
  workflowStepId?: string;
  workflowStepName?: string;
  contentHash: string;
  excerpt: string;
  safetyGateRefs: string[];
}

export interface LineageSearchTrace {
  traceId: string;
  sourceTaskId?: string;
  sourceDocumentKey?: string;
  workflowStage?: string;
  query?: string;
  sourceSystem?: string;
  providerName?: string;
  toolName?: string;
  sourcePath?: string;
  receiptIds: string[];
  authorityRecordIds: string[];
  contentHash?: string;
}

export interface LineageDraftVersion {
  versionId: string;
  taskId: string;
  workflowStage?: string;
  documentKey: string;
  revision: number;
  current: boolean;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  contentHash: string;
  parsedFrom: LineageManifestSource;
  status?: string;
  excerpt?: string;
}

export interface LineageCritiqueScore {
  scoreId: string;
  label: string;
  value: number;
  maxValue: number;
  sourceTaskIds: string[];
  sourceDocumentKeys: string[];
  diagnosticCodes: string[];
  explanation: string;
}

export interface LineageRejectedVariant {
  variantId: string;
  sourceTaskId?: string;
  sourceDocumentKey?: string;
  workflowStage?: string;
  revision?: number;
  reason: string;
  preserved: true;
}

export interface LineagePromotionRationale {
  decision: "not-promoted";
  reasons: string[];
  requiredHumanReview: string[];
  unresolvedBlockers: string[];
  safetyNotice: typeof LINEAGE_SCORING_LOG_SAFETY_NOTICE;
}

export interface LineageStageTrace {
  taskId: string;
  workflowStage: string;
  stageIndex: number;
  documentKey?: string;
  status: Task["column"];
  dependencyIds: string[];
  sourceMetadata: Record<string, unknown>;
}

export interface LineageCounts {
  stageTasks: number;
  sourceDocuments: number;
  promptTraces: number;
  searchTraces: number;
  draftVersions: number;
  critiqueScores: number;
  rejectedVariants: number;
  diagnostics: number;
  unresolvedBlockers: number;
}

export interface CounterLawsuitLineageScoringLogResult {
  runId: string;
  status: LineageStatus;
  generatedAt: string;
  lineageTaskId?: string;
  lineageScoringLogDocumentKey: typeof LINEAGE_SCORING_LOG_DOCUMENT_KEY;
  statusDocumentKey?: typeof LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY;
  stageTraces: LineageStageTrace[];
  sourceDocuments: LineageSourceTrace[];
  promptTraces: LineagePromptTrace[];
  searchTraces: LineageSearchTrace[];
  draftVersions: LineageDraftVersion[];
  critiqueScores: LineageCritiqueScore[];
  rejectedVariants: LineageRejectedVariant[];
  promotionRationale: LineagePromotionRationale;
  diagnostics: LineageDiagnostic[];
  counts: LineageCounts;
  safetyNotice: typeof LINEAGE_SCORING_LOG_SAFETY_NOTICE;
}

export interface CounterLawsuitLineageScoringLogSummary {
  runId: string;
  status: LineageStatus;
  lineageScoringLogDocumentKey?: typeof LINEAGE_SCORING_LOG_DOCUMENT_KEY | string;
  statusDocumentKey?: typeof LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY | string;
  promptTraceCount: number;
  searchTraceCount: number;
  draftVersionCount: number;
  critiqueScoreCount: number;
  rejectedVariantCount: number;
  promotionDecision: LineagePromotionRationale["decision"];
  unresolvedBlockerCount: number;
  diagnostics: LineageDiagnostic[];
  safetyNotice: typeof LINEAGE_SCORING_LOG_SAFETY_NOTICE;
}

export interface CollectCounterLawsuitLineageScoringLogOptions {
  taskStore: Pick<TaskStore, "listTasks" | "listWorkflowSteps" | "getTaskDocument" | "getTaskDocuments" | "getTaskDocumentRevisions">;
  runId: string;
  now?: () => Date;
}

export interface GenerateCounterLawsuitLineageScoringLogOptions {
  taskStore: Pick<TaskStore, "listTasks" | "listWorkflowSteps" | "getTaskDocument" | "getTaskDocuments" | "getTaskDocumentRevisions" | "upsertTaskDocument">;
  runId: string;
  force?: boolean;
  now?: () => Date;
}

interface ParsedDocument {
  document: TaskDocument | null;
  source: LineageManifestSource;
  manifest?: Record<string, unknown>;
  diagnostics: LineageDiagnostic[];
}

const MAX_EXCERPT_CHARS = 700;
const MAX_METADATA_KEYS = 12;
const MAX_REVISIONS_PER_DOCUMENT = 8;
const MAX_DIAGNOSTICS = 80;
const TOKEN_RE = /(["']?(?:authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^"'\n\r,}]+|(?<![-A-Za-z0-9_])["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|(?<![-A-Za-z0-9_])Token\s+\S{8,}|(?:sk|pk|ghp|github_pat|obsidian)[A-Za-z0-9_:\-.=+/]{8,}/gi;
const SECRET_FLAG_VALUE_RE = /(--[A-Za-z0-9_.-]*(?:token|secret|key|password|credential|auth)[A-Za-z0-9_.-]*)(\s+)(?:"[^"]+"|'[^']+'|\S+)/gi;

const STAGE_INDEX = new Map(COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage, index) => [stage.stage, index]));
const EXPECTED_STAGE_DOCUMENT_KEYS = COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage) => stage.documentKey);
const STATUS_DOCUMENT_KEYS = new Set([
  RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
  EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
  CLAIM_MAP_STATUS_DOCUMENT_KEY,
  DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
  RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
  LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
]);
const REQUIRED_UPSTREAM_DOCUMENT_KEYS = [
  RESEARCH_MEMO_DOCUMENT_KEY,
  EVIDENCE_LEDGER_DOCUMENT_KEY,
  CLAIM_MAP_DOCUMENT_KEY,
  DRAFT_COMPLAINT_DOCUMENT_KEY,
  RED_TEAM_REPORT_DOCUMENT_KEY,
];

function redactSecrets(value: string): string {
  return value
    .replace(SECRET_FLAG_VALUE_RE, "$1$2[REDACTED]")
    .replace(TOKEN_RE, (match, prefix: string | undefined) => prefix ? `${prefix}[REDACTED]` : "[REDACTED]");
}

function boundedText(value: unknown, maxChars = MAX_EXCERPT_CHARS): string | undefined {
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
  return value.map((item) => boundedText(item, maxChars)).filter((item): item is string => Boolean(item)).sort((left, right) => left.localeCompare(right));
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableId(...parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== "").join(":");
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function stageOfTask(task: Task): string | undefined {
  const stage = task.sourceMetadata?.workflowStage;
  return typeof stage === "string" ? stage : undefined;
}

function documentKeyOfTask(task: Task): string | undefined {
  const key = task.sourceMetadata?.documentKey;
  return typeof key === "string" ? key : undefined;
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const leftStage = stageOfTask(left) ?? "";
    const rightStage = stageOfTask(right) ?? "";
    const leftIndex = STAGE_INDEX.get(leftStage) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = STAGE_INDEX.get(rightStage) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || leftStage.localeCompare(rightStage) || left.id.localeCompare(right.id);
  });
}

function findStageTask(tasks: Task[], stage: string, documentKey: string): Task | undefined {
  return tasks.find((task) => stageOfTask(task) === stage)
    ?? tasks.find((task) => documentKeyOfTask(task) === documentKey);
}

function parseJsonBlock(content: string): Record<string, unknown> | undefined {
  const matches = [...content.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const match of matches) {
    try {
      const parsed = asRecord(JSON.parse(match[1]) as unknown);
      if (parsed) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseManifestFromDocument(document: TaskDocument | null, key: string): ParsedDocument {
  if (!document) {
    return {
      document,
      source: "missing",
      diagnostics: [{ code: "missing-document", severity: "warning", message: `Missing lineage source document ${key}.`, sourceDocumentKey: key }],
    };
  }
  const metadata = asRecord(document.metadata);
  if (metadata && Object.keys(metadata).length > 0) {
    return { document, source: "metadata", manifest: metadata, diagnostics: [] };
  }
  const blockManifest = parseJsonBlock(document.content ?? "");
  if (blockManifest) return { document, source: "json-block", manifest: blockManifest, diagnostics: [] };
  return {
    document,
    source: "malformed",
    diagnostics: [{
      code: "malformed-manifest",
      severity: "warning",
      message: `Document ${key} did not contain metadata or a valid JSON manifest.`,
      sourceDocumentKey: key,
      sourceTaskId: document.taskId,
    }],
  };
}

function normalizeDiagnostics(...groups: Array<Array<LineageDiagnostic> | undefined>): LineageDiagnostic[] {
  const diagnostics: LineageDiagnostic[] = [];
  for (const group of groups) {
    for (const diagnostic of group ?? []) {
      diagnostics.push({
        code: boundedText(diagnostic.code, 180) ?? "lineage-diagnostic",
        severity: diagnostic.severity === "error" || diagnostic.severity === "warning" || diagnostic.severity === "info" ? diagnostic.severity : "warning",
        message: boundedText(diagnostic.message, 500) ?? "Lineage diagnostic requires review.",
        sourceTaskId: boundedText(diagnostic.sourceTaskId, 180),
        sourceDocumentKey: boundedText(diagnostic.sourceDocumentKey, 180),
        workflowStage: boundedText(diagnostic.workflowStage, 180),
      });
    }
  }
  return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function statusFromManifest(manifest: Record<string, unknown> | undefined): string | undefined {
  return boundedText(manifest?.status, 80);
}

function metadataSummary(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const summary: Record<string, unknown> = {};
  for (const key of Object.keys(metadata).sort().slice(0, MAX_METADATA_KEYS)) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      summary[key] = typeof value === "string" ? boundedText(value, 180) : value;
    } else if (Array.isArray(value)) {
      summary[key] = `array(${value.length})`;
    } else if (value && typeof value === "object") {
      summary[key] = `object(${Object.keys(value).length})`;
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function diagnosticsFromManifest(manifest: Record<string, unknown> | undefined, fallbackDocumentKey?: string, fallbackTaskId?: string): LineageDiagnostic[] {
  return manifestArray(manifest, ["diagnostics", "providerDiagnostics"]).map((record) => ({
    code: boundedText(record.code, 180) ?? boundedText(record.providerName, 180) ?? "upstream-diagnostic",
    severity: record.severity === "error" || record.status === "error" || record.status === "failed" ? "error" : record.severity === "info" ? "info" : "warning",
    message: boundedText(record.message, 500) ?? "Upstream artifact diagnostic requires review before lineage can be treated as complete.",
    sourceDocumentKey: boundedText(record.sourceDocumentKey, 180) ?? fallbackDocumentKey,
    sourceTaskId: boundedText(record.sourceTaskId, 180) ?? fallbackTaskId,
    workflowStage: boundedText(record.workflowStage, 180),
  }));
}

function sourceTraceFromDocument(params: {
  task: Task;
  document: TaskDocument;
  parsed: ParsedDocument;
  revisionCount: number;
}): LineageSourceTrace {
  const workflowStage = stageOfTask(params.task);
  return {
    traceId: stableId(params.task.id, params.document.key, params.document.revision),
    taskId: params.task.id,
    workflowStage,
    documentKey: params.document.key,
    present: true,
    parsedFrom: params.parsed.source,
    status: statusFromManifest(params.parsed.manifest),
    revision: params.document.revision,
    author: boundedText(params.document.author, 120),
    createdAt: params.document.createdAt,
    updatedAt: params.document.updatedAt,
    contentHash: hashText(params.document.content ?? ""),
    metadataSummary: metadataSummary(params.document.metadata),
    excerpt: boundedText(params.document.content),
    revisionCount: params.revisionCount,
  };
}

function draftVersionFromCurrent(params: { task: Task; document: TaskDocument; parsed: ParsedDocument }): LineageDraftVersion {
  return {
    versionId: stableId("current", params.task.id, params.document.key, params.document.revision),
    taskId: params.task.id,
    workflowStage: stageOfTask(params.task),
    documentKey: params.document.key,
    revision: params.document.revision,
    current: true,
    author: boundedText(params.document.author, 120),
    createdAt: params.document.createdAt,
    updatedAt: params.document.updatedAt,
    contentHash: hashText(params.document.content ?? ""),
    parsedFrom: params.parsed.source,
    status: statusFromManifest(params.parsed.manifest),
    excerpt: boundedText(params.document.content),
  };
}

function draftVersionFromRevision(params: { task: Task; documentKey: string; revision: TaskDocumentRevision }): LineageDraftVersion {
  const parsed = parseManifestFromDocument({
    id: String(params.revision.id),
    taskId: params.revision.taskId,
    key: params.revision.key,
    content: params.revision.content,
    revision: params.revision.revision,
    author: params.revision.author,
    metadata: params.revision.metadata,
    createdAt: params.revision.createdAt,
    updatedAt: params.revision.createdAt,
  }, params.documentKey);
  return {
    versionId: stableId("revision", params.task.id, params.documentKey, params.revision.revision),
    taskId: params.task.id,
    workflowStage: stageOfTask(params.task),
    documentKey: params.documentKey,
    revision: params.revision.revision,
    current: false,
    author: boundedText(params.revision.author, 120),
    createdAt: params.revision.createdAt,
    contentHash: hashText(params.revision.content ?? ""),
    parsedFrom: parsed.source,
    status: statusFromManifest(parsed.manifest),
    excerpt: boundedText(params.revision.content),
  };
}

function promptTrace(params: {
  sourceType: LineagePromptTrace["sourceType"];
  text: string;
  taskId?: string;
  workflowStage?: string;
  documentKey?: string;
  workflowStep?: WorkflowStep;
}): LineagePromptTrace | undefined {
  const excerpt = boundedText(params.text, 700);
  if (!excerpt) return undefined;
  return {
    traceId: stableId(params.sourceType, params.taskId, params.documentKey, params.workflowStep?.id, hashText(excerpt).slice(0, 12)),
    sourceType: params.sourceType,
    taskId: params.taskId,
    workflowStage: params.workflowStage,
    documentKey: params.documentKey,
    workflowStepId: params.workflowStep?.id,
    workflowStepName: params.workflowStep?.name,
    contentHash: hashText(params.text),
    excerpt,
    safetyGateRefs: uniqueSorted([
      params.text.includes("citation") || params.text.includes("source") ? "citation-source-verification" : undefined,
      params.text.includes("red-team") || params.text.includes("opposing-counsel") ? "opposing-counsel-red-team" : undefined,
      params.text.includes("lineage") ? "lineage-preservation" : undefined,
    ]),
  };
}

function collectSearchTracesFromManifest(params: {
  task: Task;
  documentKey: string;
  manifest: Record<string, unknown> | undefined;
}): LineageSearchTrace[] {
  const traces: LineageSearchTrace[] = [];
  for (const record of manifestArray(params.manifest, ["searches", "queries"])) {
    const query = boundedText(record.query ?? record.searchQuery ?? record, 300);
    traces.push({
      traceId: stableId("search", params.task.id, params.documentKey, query, traces.length),
      sourceTaskId: params.task.id,
      sourceDocumentKey: params.documentKey,
      workflowStage: stageOfTask(params.task),
      query,
      sourceSystem: boundedText(record.sourceSystem, 120),
      providerName: boundedText(record.providerName, 120),
      toolName: boundedText(record.toolName, 120),
      sourcePath: boundedText(record.sourcePath, 300),
      receiptIds: stringArray(record.receiptIds),
      authorityRecordIds: stringArray(record.authorityRecordIds),
      contentHash: query ? hashText(query) : undefined,
    });
  }
  for (const record of manifestArray(params.manifest, ["receipts", "evidence", "sourceLinks"])) {
    const sourcePath = boundedText(record.sourcePath, 300);
    const receiptId = boundedText(record.receiptId, 180);
    const query = boundedText(record.query, 300);
    traces.push({
      traceId: stableId("source", params.task.id, params.documentKey, receiptId ?? sourcePath, traces.length),
      sourceTaskId: params.task.id,
      sourceDocumentKey: params.documentKey,
      workflowStage: stageOfTask(params.task),
      query,
      sourceSystem: boundedText(record.sourceSystem, 120),
      providerName: boundedText(record.providerName, 120),
      toolName: boundedText(record.toolName, 120),
      sourcePath,
      receiptIds: uniqueSorted([receiptId, ...stringArray(record.receiptIds)]),
      authorityRecordIds: stringArray(record.authorityRecordIds),
      contentHash: hashText(JSON.stringify({ sourcePath, receiptId, query })),
    });
  }
  return traces;
}

function stageTraceFromTask(task: Task): LineageStageTrace {
  const workflowStage = stageOfTask(task) ?? "unknown";
  return {
    taskId: task.id,
    workflowStage,
    stageIndex: STAGE_INDEX.get(workflowStage) ?? Number.MAX_SAFE_INTEGER,
    documentKey: documentKeyOfTask(task),
    status: task.column,
    dependencyIds: [...(task.dependencies ?? [])].sort((left, right) => left.localeCompare(right)),
    sourceMetadata: Object.fromEntries(Object.entries(task.sourceMetadata ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function statusFromDiagnostics(params: { lineageStagePresent: boolean; upstreamMissing: number; malformed: number; statusBlockers: number; diagnostics: LineageDiagnostic[] }): LineageStatus {
  if (!params.lineageStagePresent) return "not-run";
  if (params.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return "blocked";
  if (params.upstreamMissing > 0 || params.malformed > 0 || params.statusBlockers > 0) return "partial";
  return "completed";
}

function promotionRationale(diagnostics: LineageDiagnostic[]): LineagePromotionRationale {
  const blockers = diagnostics
    .filter((diagnostic) => diagnostic.severity === "error" || diagnostic.code.includes("status") || diagnostic.code.includes("missing"))
    .map((diagnostic) => `${diagnostic.code}${diagnostic.sourceDocumentKey ? ` (${diagnostic.sourceDocumentKey})` : ""}`);
  return {
    decision: "not-promoted",
    reasons: [
      "The counter-lawsuit prototype keeps every score as a workflow diagnostic.",
      "No generated artifact is promoted as legally reliable, verified, good-law checked, citation-format validated, or filing-ready.",
    ],
    requiredHumanReview: [
      "qualified legal review",
      "source and receipt review",
      "citation-format review",
      "good-law validation",
      "filing-readiness review",
    ],
    unresolvedBlockers: uniqueSorted(blockers),
    safetyNotice: LINEAGE_SCORING_LOG_SAFETY_NOTICE,
  };
}

function countsFromResult(result: Omit<CounterLawsuitLineageScoringLogResult, "counts">): LineageCounts {
  return {
    stageTasks: result.stageTraces.length,
    sourceDocuments: result.sourceDocuments.length,
    promptTraces: result.promptTraces.length,
    searchTraces: result.searchTraces.length,
    draftVersions: result.draftVersions.length,
    critiqueScores: result.critiqueScores.length,
    rejectedVariants: result.rejectedVariants.length,
    diagnostics: result.diagnostics.length,
    unresolvedBlockers: result.promotionRationale.unresolvedBlockers.length,
  };
}

function lineageSummaryFromResult(result: CounterLawsuitLineageScoringLogResult): CounterLawsuitLineageScoringLogSummary {
  return {
    runId: result.runId,
    status: result.status,
    lineageScoringLogDocumentKey: result.status === "not-run" ? undefined : result.lineageScoringLogDocumentKey,
    statusDocumentKey: result.statusDocumentKey,
    promptTraceCount: result.counts.promptTraces,
    searchTraceCount: result.counts.searchTraces,
    draftVersionCount: result.counts.draftVersions,
    critiqueScoreCount: result.counts.critiqueScores,
    rejectedVariantCount: result.counts.rejectedVariants,
    promotionDecision: result.promotionRationale.decision,
    unresolvedBlockerCount: result.counts.unresolvedBlockers,
    diagnostics: result.diagnostics,
    safetyNotice: result.safetyNotice,
  };
}

export { lineageSummaryFromResult as lineageScoringLogSummaryFromResult };

export async function collectCounterLawsuitLineageScoringLogInputs(options: CollectCounterLawsuitLineageScoringLogOptions): Promise<CounterLawsuitLineageScoringLogResult> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const tasks = sortTasks((await options.taskStore.listTasks({ includeArchived: true } as never)).filter((task) => taskMatchesRun(task, options.runId)));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${options.runId} not found`);

  const lineageTask = findStageTask(tasks, LINEAGE_SCORING_LOG_DOCUMENT_KEY, LINEAGE_SCORING_LOG_DOCUMENT_KEY);
  const stageTraces = tasks.map(stageTraceFromTask);
  const workflowSteps = (await options.taskStore.listWorkflowSteps())
    .filter((step) => step.enabled && step.mode === "prompt")
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const sourceDocuments: LineageSourceTrace[] = [];
  const promptTraces: LineagePromptTrace[] = [];
  const searchTraces: LineageSearchTrace[] = [];
  const draftVersions: LineageDraftVersion[] = [];
  const rejectedVariants: LineageRejectedVariant[] = [];
  const diagnostics: LineageDiagnostic[] = [];
  let malformed = 0;
  let statusBlockers = 0;

  for (const task of tasks) {
    const workflowStage = stageOfTask(task);
    const taskPrompt = promptTrace({ sourceType: "stage-task", text: `${task.title ?? ""}\n${task.description ?? ""}`, taskId: task.id, workflowStage });
    if (taskPrompt) promptTraces.push(taskPrompt);

    const documents = [...await options.taskStore.getTaskDocuments(task.id).catch(() => [])]
      .sort((left, right) => left.key.localeCompare(right.key) || left.revision - right.revision);
    for (const document of documents) {
      const parsed = parseManifestFromDocument(document, document.key);
      if (parsed.source === "malformed") malformed += 1;
      diagnostics.push(...parsed.diagnostics);
      diagnostics.push(...diagnosticsFromManifest(parsed.manifest, document.key, task.id));
      const status = statusFromManifest(parsed.manifest);
      if (STATUS_DOCUMENT_KEYS.has(document.key) && status && status !== "completed") {
        statusBlockers += 1;
        diagnostics.push({
          code: "status-document-blocker",
          severity: status === "failed" || status === "blocked" ? "error" : "warning",
          message: `${document.key} reports ${status}; lineage keeps it as an unresolved workflow limitation, not source support.`,
          sourceDocumentKey: document.key,
          sourceTaskId: task.id,
          workflowStage,
        });
      }
      const revisions = [...await options.taskStore.getTaskDocumentRevisions(task.id, document.key, { limit: MAX_REVISIONS_PER_DOCUMENT }).catch(() => [])]
        .sort((left, right) => left.revision - right.revision);
      sourceDocuments.push(sourceTraceFromDocument({ task, document, parsed, revisionCount: revisions.length }));
      if (document.key === COUNTER_LAWSUIT_RUN_DOCUMENT_KEY) {
        const runPrompt = promptTrace({ sourceType: "run-document", text: document.content, taskId: task.id, workflowStage, documentKey: document.key });
        if (runPrompt) promptTraces.push(runPrompt);
      }
      if (document.key === COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY) {
        const stagePrompt = promptTrace({ sourceType: "stage-document", text: document.content, taskId: task.id, workflowStage, documentKey: document.key });
        if (stagePrompt) promptTraces.push(stagePrompt);
      }
      if (EXPECTED_STAGE_DOCUMENT_KEYS.includes(document.key)) {
        draftVersions.push(draftVersionFromCurrent({ task, document, parsed }));
        for (const revision of revisions) {
          draftVersions.push(draftVersionFromRevision({ task, documentKey: document.key, revision }));
          rejectedVariants.push({
            variantId: stableId("prior-revision", task.id, document.key, revision.revision),
            sourceTaskId: task.id,
            sourceDocumentKey: document.key,
            workflowStage,
            revision: revision.revision,
            reason: "Prior document revision is preserved for lineage and is superseded by the current task document, not deleted or promoted.",
            preserved: true,
          });
        }
      }
      searchTraces.push(...collectSearchTracesFromManifest({ task, documentKey: document.key, manifest: parsed.manifest }));
    }
  }

  for (const step of workflowSteps) {
    const trace = promptTrace({ sourceType: "workflow-step", text: step.prompt, workflowStep: step });
    if (trace) promptTraces.push(trace);
  }

  let upstreamMissing = 0;
  for (const key of REQUIRED_UPSTREAM_DOCUMENT_KEYS) {
    if (!sourceDocuments.some((document) => document.documentKey === key && document.present)) {
      upstreamMissing += 1;
      diagnostics.push({
        code: "missing-upstream-artifact",
        severity: "error",
        message: `Required upstream artifact ${key} is missing for lineage collection.`,
        sourceDocumentKey: key,
      });
    }
  }
  if (!lineageTask) {
    diagnostics.push({
      code: "missing-stage-task",
      severity: "info",
      message: `Workflow run ${options.runId} has no ${LINEAGE_SCORING_LOG_DOCUMENT_KEY} stage task; this is treated as not-run for backward compatibility with older runs.`,
      workflowStage: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
    });
  }

  const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
  const status = statusFromDiagnostics({
    lineageStagePresent: Boolean(lineageTask),
    upstreamMissing,
    malformed,
    statusBlockers,
    diagnostics: normalizedDiagnostics,
  });
  const promotion = promotionRationale(normalizedDiagnostics);
  const base = {
    runId: options.runId,
    status,
    generatedAt,
    lineageTaskId: lineageTask?.id,
    lineageScoringLogDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
    statusDocumentKey: status === "completed" || status === "not-run" ? undefined : LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
    stageTraces,
    sourceDocuments,
    promptTraces: promptTraces.sort((left, right) => left.traceId.localeCompare(right.traceId)),
    searchTraces: searchTraces.sort((left, right) => left.traceId.localeCompare(right.traceId)),
    draftVersions: draftVersions.sort((left, right) => left.taskId.localeCompare(right.taskId) || left.documentKey.localeCompare(right.documentKey) || left.revision - right.revision || Number(left.current) - Number(right.current)),
    critiqueScores: [],
    rejectedVariants: rejectedVariants.sort((left, right) => left.variantId.localeCompare(right.variantId)),
    promotionRationale: promotion,
    diagnostics: normalizedDiagnostics,
    safetyNotice: LINEAGE_SCORING_LOG_SAFETY_NOTICE,
  } satisfies Omit<CounterLawsuitLineageScoringLogResult, "counts">;
  return { ...base, counts: countsFromResult(base) };
}

function notRunSummary(runId: string, diagnostics: LineageDiagnostic[] = []): CounterLawsuitLineageScoringLogSummary {
  return {
    runId,
    status: "not-run",
    lineageScoringLogDocumentKey: undefined,
    statusDocumentKey: undefined,
    promptTraceCount: 0,
    searchTraceCount: 0,
    draftVersionCount: 0,
    critiqueScoreCount: 0,
    rejectedVariantCount: 0,
    promotionDecision: "not-promoted",
    unresolvedBlockerCount: 0,
    diagnostics,
    safetyNotice: LINEAGE_SCORING_LOG_SAFETY_NOTICE,
  };
}

function summaryFromManifest(params: { runId: string; manifest: Record<string, unknown>; statusDocumentKey?: string }): CounterLawsuitLineageScoringLogSummary {
  const counts = asRecord(params.manifest.counts);
  const promotion = asRecord(params.manifest.promotionRationale);
  const status = typeof params.manifest.status === "string" ? params.manifest.status as LineageStatus : "completed";
  const diagnostics = normalizeDiagnostics(diagnosticsFromManifest(params.manifest, LINEAGE_SCORING_LOG_DOCUMENT_KEY));
  return {
    runId: params.runId,
    status,
    lineageScoringLogDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
    statusDocumentKey: params.statusDocumentKey,
    promptTraceCount: typeof counts?.promptTraces === "number" ? counts.promptTraces : manifestArray(params.manifest, ["promptTraces"]).length,
    searchTraceCount: typeof counts?.searchTraces === "number" ? counts.searchTraces : manifestArray(params.manifest, ["searchTraces"]).length,
    draftVersionCount: typeof counts?.draftVersions === "number" ? counts.draftVersions : manifestArray(params.manifest, ["draftVersions"]).length,
    critiqueScoreCount: typeof counts?.critiqueScores === "number" ? counts.critiqueScores : manifestArray(params.manifest, ["critiqueScores"]).length,
    rejectedVariantCount: typeof counts?.rejectedVariants === "number" ? counts.rejectedVariants : manifestArray(params.manifest, ["rejectedVariants"]).length,
    promotionDecision: promotion?.decision === "not-promoted" ? "not-promoted" : "not-promoted",
    unresolvedBlockerCount: typeof counts?.unresolvedBlockers === "number" ? counts.unresolvedBlockers : 0,
    diagnostics,
    safetyNotice: LINEAGE_SCORING_LOG_SAFETY_NOTICE,
  };
}

function statusSummaryFromStatusDocument(params: { runId: string; statusDoc: TaskDocument; primaryPresent: boolean }): CounterLawsuitLineageScoringLogSummary {
  const parsed = parseManifestFromDocument(params.statusDoc, LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY);
  if (!parsed.manifest) {
    return {
      ...notRunSummary(params.runId, parsed.diagnostics),
      status: "failed",
      lineageScoringLogDocumentKey: params.primaryPresent ? LINEAGE_SCORING_LOG_DOCUMENT_KEY : undefined,
      statusDocumentKey: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
    };
  }
  const base = summaryFromManifest({ runId: params.runId, manifest: parsed.manifest, statusDocumentKey: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY });
  if (!params.primaryPresent && base.status === "completed") {
    return {
      ...base,
      status: "failed",
      lineageScoringLogDocumentKey: undefined,
      diagnostics: normalizeDiagnostics(base.diagnostics, [{
        code: "missing-primary-lineage-log",
        severity: "error",
        message: `${LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY} reported completed but ${LINEAGE_SCORING_LOG_DOCUMENT_KEY} is missing.`,
        sourceDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
      }]),
    };
  }
  return base;
}

export async function deriveLineageScoringLogStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<CounterLawsuitLineageScoringLogSummary> {
  const tasks = sortTasks((await params.taskStore.listTasks({ includeArchived: true } as never)).filter((task) => taskMatchesRun(task, params.runId)));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${params.runId} not found`);

  const lineageTask = findStageTask(tasks, LINEAGE_SCORING_LOG_DOCUMENT_KEY, LINEAGE_SCORING_LOG_DOCUMENT_KEY);
  if (!lineageTask) return notRunSummary(params.runId);

  const [primaryDoc, statusDoc] = await Promise.all([
    params.taskStore.getTaskDocument(lineageTask.id, LINEAGE_SCORING_LOG_DOCUMENT_KEY).catch(() => null),
    params.taskStore.getTaskDocument(lineageTask.id, LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY).catch(() => null),
  ]);

  if (statusDoc) {
    const parsedStatus = parseManifestFromDocument(statusDoc, LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY);
    const status = statusFromManifest(parsedStatus.manifest);
    if (!parsedStatus.manifest || !primaryDoc || status !== "completed") {
      return statusSummaryFromStatusDocument({ runId: params.runId, statusDoc, primaryPresent: Boolean(primaryDoc) });
    }
  }

  if (!primaryDoc) return notRunSummary(params.runId, [{
    code: "missing-primary-lineage-log",
    severity: "warning",
    message: `${LINEAGE_SCORING_LOG_DOCUMENT_KEY} has not been generated for this run.`,
    sourceDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
    sourceTaskId: lineageTask.id,
    workflowStage: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
  }]);

  const parsed = parseManifestFromDocument(primaryDoc, LINEAGE_SCORING_LOG_DOCUMENT_KEY);
  if (!parsed.manifest) {
    return {
      ...notRunSummary(params.runId, parsed.diagnostics),
      status: "failed",
      lineageScoringLogDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
      statusDocumentKey: statusDoc ? LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY : undefined,
    };
  }
  return summaryFromManifest({ runId: params.runId, manifest: parsed.manifest, statusDocumentKey: statusDoc ? LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY : undefined });
}

function buildLineageScoringLogManifest(result: CounterLawsuitLineageScoringLogResult): Record<string, unknown> {
  return {
    runId: result.runId,
    generatedAt: result.generatedAt,
    status: result.status,
    lineageTaskId: result.lineageTaskId,
    lineageScoringLogDocumentKey: result.lineageScoringLogDocumentKey,
    statusDocumentKey: result.statusDocumentKey,
    stageTraces: result.stageTraces,
    sourceDocuments: result.sourceDocuments,
    promptTraces: result.promptTraces,
    searchTraces: result.searchTraces,
    draftVersions: result.draftVersions,
    critiqueScores: result.critiqueScores,
    rejectedVariants: result.rejectedVariants,
    promotionRationale: result.promotionRationale,
    diagnostics: result.diagnostics,
    counts: result.counts,
    safetyNotice: result.safetyNotice,
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatDiagnostics(diagnostics: LineageDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.sourceDocumentKey ? ` [${diagnostic.sourceDocumentKey}]` : ""}${diagnostic.sourceTaskId ? ` (${diagnostic.sourceTaskId})` : ""}: ${diagnostic.message}`).join("\n") || "- None.";
}

function buildLineageScoringLogMarkdown(result: CounterLawsuitLineageScoringLogResult): string {
  const manifest = buildLineageScoringLogManifest(result);
  const stageRows = result.stageTraces.map((stage) => `| ${escapeCell(stage.workflowStage)} | ${escapeCell(stage.taskId)} | ${escapeCell(stage.documentKey ?? "none")} | ${escapeCell(stage.status)} |`).join("\n");
  const sourceRows = result.sourceDocuments.map((source) => `| ${escapeCell(source.documentKey)} | ${escapeCell(source.taskId)} | ${escapeCell(source.workflowStage ?? "unknown")} | ${source.revision ?? ""} | ${escapeCell(source.parsedFrom)} | ${escapeCell(source.status ?? "unknown")} | ${escapeCell(source.contentHash ?? "missing")} |`).join("\n");
  return `# Lineage and scoring log

${LINEAGE_SCORING_LOG_SAFETY_NOTICE}

## Safety boundary

This log preserves workflow lineage and diagnostic scoring only. It does not verify facts, validate citations, certify good-law status, approve legal strategy, promote any artifact, or mark anything filing-ready.

## Run context

- Workflow run ID: ${result.runId}
- Lineage task ID: ${result.lineageTaskId ?? "unknown"}
- Generated at: ${result.generatedAt}
- Status: ${result.status}
- Primary document key: ${result.lineageScoringLogDocumentKey}
- Status document key: ${result.statusDocumentKey ?? LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY}
- Promotion decision: ${result.promotionRationale.decision}

## Stage lineage

| Stage | Task ID | Document key | Task status |
| --- | --- | --- | --- |
${stageRows || "| none | none | none | unknown |"}

## Source documents

| Document key | Task ID | Stage | Revision | Parsed from | Status | Content hash |
| --- | --- | --- | --- | --- | --- | --- |
${sourceRows || "| none | none | unknown |  | missing | unknown | missing |"}

## Counts

- Prompt traces: ${result.counts.promptTraces}
- Search traces: ${result.counts.searchTraces}
- Draft versions: ${result.counts.draftVersions}
- Critique scores: ${result.counts.critiqueScores}
- Rejected variants: ${result.counts.rejectedVariants}
- Unresolved blockers: ${result.counts.unresolvedBlockers}

## Diagnostics

${formatDiagnostics(result.diagnostics)}

## Machine-readable JSON manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

function statusDocumentInput(result: CounterLawsuitLineageScoringLogResult): { key: string; content: string; metadata: Record<string, unknown>; author: string } {
  const metadata = {
    runId: result.runId,
    status: result.status,
    lineageScoringLogDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
    statusDocumentKey: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
    promptTraceCount: result.counts.promptTraces,
    searchTraceCount: result.counts.searchTraces,
    draftVersionCount: result.counts.draftVersions,
    critiqueScoreCount: result.counts.critiqueScores,
    rejectedVariantCount: result.counts.rejectedVariants,
    promotionDecision: result.promotionRationale.decision,
    unresolvedBlockerCount: result.counts.unresolvedBlockers,
    diagnostics: result.diagnostics,
    counts: result.counts,
    safetyNotice: LINEAGE_SCORING_LOG_SAFETY_NOTICE,
  };
  return {
    key: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
    content: `# Lineage and scoring log status\n\nStatus: ${result.status}\n\n${LINEAGE_SCORING_LOG_SAFETY_NOTICE}\n\n${formatDiagnostics(result.diagnostics)}\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`,
    metadata,
    author: "fusion-legal-lineage-scoring-log",
  };
}

export async function generateCounterLawsuitLineageScoringLog(options: GenerateCounterLawsuitLineageScoringLogOptions): Promise<CounterLawsuitLineageScoringLogResult> {
  void options.force;
  const result = await collectCounterLawsuitLineageScoringLogInputs(options);
  const taskId = result.lineageTaskId;
  if (!taskId) return result;
  try {
    await options.taskStore.upsertTaskDocument(taskId, {
      key: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
      content: buildLineageScoringLogMarkdown(result),
      author: "fusion-legal-lineage-scoring-log",
      metadata: buildLineageScoringLogManifest(result),
    });
    if (result.status !== "completed") {
      await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput(result));
    } else {
      const staleStatus = await options.taskStore.getTaskDocument(taskId, LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY).catch(() => null);
      if (staleStatus) await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput({ ...result, statusDocumentKey: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY }));
    }
    return result;
  } catch (error) {
    const failedResult: CounterLawsuitLineageScoringLogResult = {
      ...result,
      status: "failed",
      statusDocumentKey: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
      diagnostics: normalizeDiagnostics(result.diagnostics, [{
        code: "lineage-scoring-log-generation-failed",
        severity: "error",
        message: `Lineage/scoring log generation failed: ${error instanceof Error ? boundedText(error.message, 500) : boundedText(String(error), 500)}`,
        sourceDocumentKey: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
        sourceTaskId: taskId,
        workflowStage: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
      }]),
    };
    await options.taskStore.upsertTaskDocument(taskId, statusDocumentInput({ ...failedResult, promotionRationale: promotionRationale(failedResult.diagnostics), counts: countsFromResult({ ...failedResult, promotionRationale: promotionRationale(failedResult.diagnostics) }) }));
    return { ...failedResult, promotionRationale: promotionRationale(failedResult.diagnostics), counts: countsFromResult({ ...failedResult, promotionRationale: promotionRationale(failedResult.diagnostics) }) };
  }
}
