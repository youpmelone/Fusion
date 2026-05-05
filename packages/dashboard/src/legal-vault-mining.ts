import { createHash } from "node:crypto";
import type { ResearchRun, ResearchStore, ResearchSource, Task, TaskDocument, TaskStore } from "@fusion/core";
import { searchProjectMemory, type MemorySearchResult } from "@fusion/core";
import { badRequest, notFound } from "./api-error.js";
import {
  assertAllowedLegalMcpTool,
  createLegalMcpClientFromProjectConfig,
  isAllowedLegalMcpTool,
  type LegalMcpClient,
  type LegalMcpProviderName,
  type LegalMcpTool,
} from "./legal-mcp-client.js";
import {
  COUNTER_LAWSUIT_WORKFLOW_KIND,
  COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY,
  type CounterLawsuitWorkflowLaunchInput,
} from "./legal-workflow-orchestrator.js";

export const VAULT_MINING_RECEIPTS_DOCUMENT_KEY = "vault-mining-receipts";
export const VAULT_MINING_STATUS_DOCUMENT_KEY = "vault-mining-status";
export const VAULT_MINING_RESEARCH_TRIGGER = "legal-counter-lawsuit-vault-mining";

export type VaultMiningSourceSystem = "qmd-mcp" | "obsidian-mcp" | "qmd-memory-fallback";
export type VaultMiningProviderStatus = "available" | "unavailable" | "partial" | "error" | "skipped";

export interface VaultMiningProviderOverrides {
  qmd?: { serverName?: string; searchToolName?: string };
  obsidian?: { serverName?: string; searchToolName?: string; readToolName?: string };
}

export interface VaultMiningRequest {
  runId: string;
  matterName?: string;
  focus?: string;
  vaultScope?: string;
  sourceScope?: string;
  sourceQuery?: string;
  queries?: string[];
  maxQueries?: number;
  maxResultsPerProvider?: number;
  providerOverrides?: VaultMiningProviderOverrides;
}

export interface VaultMiningProviderPayload {
  providerName: "qmd" | "obsidian" | "qmd-memory-fallback";
  sourceSystem: VaultMiningSourceSystem;
  mcpServerName?: string;
  toolName: string;
  query: string;
  rawResult: unknown;
  retrievedAt?: string;
}

export interface PersistedVaultMiningReceipt {
  receiptId: string;
  sourceSystem: VaultMiningSourceSystem;
  providerName: string;
  mcpServerName?: string;
  toolName: string;
  query: string;
  sourcePath: string;
  sourceUri?: string;
  lineStart?: number;
  lineEnd?: number;
  title?: string;
  excerpt: string;
  retrievedAt: string;
  hash: string;
  verified: false;
  rawResultSummary?: string;
}

export interface RejectedVaultMiningHit {
  providerName: string;
  sourceSystem: VaultMiningSourceSystem;
  mcpServerName?: string;
  toolName: string;
  query: string;
  reason: string;
  rawResultSummary?: string;
}

export interface VaultMiningProviderDiagnostic {
  providerName: string;
  sourceSystem?: VaultMiningSourceSystem;
  mcpServerName?: string;
  status: VaultMiningProviderStatus;
  message: string;
  toolName?: string;
  redactedConfig?: Record<string, unknown>;
  acceptedCount?: number;
  rejectedCount?: number;
  rejectedHits?: RejectedVaultMiningHit[];
}

export interface VaultMiningResult {
  runId: string;
  status: "completed" | "partial" | "unavailable" | "failed";
  researchRunId?: string;
  receiptCount: number;
  receipts: PersistedVaultMiningReceipt[];
  receiptsDocumentKey: typeof VAULT_MINING_RECEIPTS_DOCUMENT_KEY;
  statusDocumentKey?: typeof VAULT_MINING_STATUS_DOCUMENT_KEY;
  providerDiagnostics: VaultMiningProviderDiagnostic[];
  rejectedHits: RejectedVaultMiningHit[];
  queries: string[];
}

export interface MineCounterLawsuitVaultSourcesOptions {
  taskStore: Pick<TaskStore, "listTasks" | "upsertTaskDocument" | "getTaskDocument" | "getResearchStore"> & Partial<Pick<TaskStore, "getRootDir">>;
  runId: string;
  launchInput?: CounterLawsuitWorkflowLaunchInput;
  request?: Partial<VaultMiningRequest>;
  mcpClientFactory?: LegalVaultMcpClientFactory;
  searchProjectMemoryFn?: typeof searchProjectMemory;
  now?: () => Date;
}

export type LegalVaultMcpClientFactory = (params: {
  rootDir: string;
  provider: LegalMcpProviderName;
  serverName?: string;
}) => Promise<{ client: LegalMcpClient; mcpServerName: string; redactedConfig?: Record<string, unknown> } | null>;

const MAX_EXCERPT_CHARS = 1_200;
const MAX_SUMMARY_CHARS = 500;
const MAX_QUERY_CHARS = 300;
const DEFAULT_MAX_QUERIES = 6;
const DEFAULT_MAX_RESULTS_PER_PROVIDER = 8;
const HARD_MAX_QUERIES = 10;
const HARD_MAX_RESULTS_PER_PROVIDER = 20;
const TOKEN_RE = /["']?(?:authorization)["']?\s*[:=]\s*["']?bearer\s+[^"'\s,}]{8,}["']?|["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|(?:sk|pk|ghp|github_pat|obsidian)[A-Za-z0-9_:\-.=+/]{8,}/gi;
const TOKEN_KEY_RE = /(?:token|secret|api[_-]?key|password|credential|auth)/i;

function redactSecrets(value: string): string {
  return value.replace(TOKEN_RE, "[REDACTED]");
}

function boundedText(value: unknown, maxChars = MAX_EXCERPT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function boundedOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function rawSummary(raw: unknown): string {
  if (Array.isArray(raw)) return `array(${raw.length})`;
  if (!raw || typeof raw !== "object") return boundedText(String(raw), MAX_SUMMARY_CHARS) ?? "primitive";
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => !TOKEN_KEY_RE.test(key)).slice(0, 8);
  const count = Array.isArray(record.results) ? record.results.length
    : Array.isArray(record.matches) ? record.matches.length
      : Array.isArray(record.items) ? record.items.length
        : Array.isArray(record.content) ? record.content.length
          : undefined;
  return redactSecrets(`object(keys=${keys.join(",")}${count !== undefined ? `, results=${count}` : ""})`).slice(0, MAX_SUMMARY_CHARS);
}

function tryParseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function extractMcpContentResults(record: Record<string, unknown>): unknown[] | undefined {
  if (record.structuredContent !== undefined) {
    const structured = candidateResults(record.structuredContent);
    if (structured.length > 0) return structured;
  }
  if (!Array.isArray(record.content)) return undefined;
  const expanded: unknown[] = [];
  for (const item of record.content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      expanded.push(item);
      continue;
    }
    const contentItem = item as Record<string, unknown>;
    if (typeof contentItem.text === "string") {
      const parsed = tryParseJsonText(contentItem.text);
      if (parsed !== undefined) {
        expanded.push(...candidateResults(parsed));
      } else {
        expanded.push({ text: contentItem.text });
      }
      continue;
    }
    expanded.push(contentItem);
  }
  return expanded;
}

function candidateResults(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [raw];
  const record = raw as Record<string, unknown>;
  const mcpContentResults = extractMcpContentResults(record);
  if (mcpContentResults) return mcpContentResults;
  for (const key of ["results", "matches", "items", "sources", "documents"] as const) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  if (record.content && typeof record.content === "object" && !Array.isArray(record.content) && Array.isArray((record.content as Record<string, unknown>).results)) {
    return (record.content as Record<string, unknown>).results as unknown[];
  }
  return [raw];
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeHitRecord(hit: unknown): Record<string, unknown> {
  if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
    return { text: typeof hit === "string" ? hit : JSON.stringify(hit) };
  }
  const record = hit as Record<string, unknown>;
  const nested = nestedRecord(record.source) ?? nestedRecord(record.file) ?? nestedRecord(record.metadata);
  return nested ? { ...nested, ...record } : record;
}

function extractSourcePath(record: Record<string, unknown>): string | undefined {
  const direct = pickString(record, ["sourcePath", "source_path", "path", "filePath", "file_path", "vaultPath", "vault_path", "notePath", "note_path", "filename"]);
  if (direct) return direct;
  const uri = pickString(record, ["uri", "url", "sourceUri", "source_uri"]);
  if (uri?.startsWith("file://")) return uri.replace(/^file:\/\//, "");
  return undefined;
}

function contentHash(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function normalizeVaultMiningProviderPayload(
  payload: VaultMiningProviderPayload,
  options: { maxResults?: number } = {},
): { receipts: PersistedVaultMiningReceipt[]; rejectedHits: RejectedVaultMiningHit[] } {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS_PER_PROVIDER, HARD_MAX_RESULTS_PER_PROVIDER));
  const retrievedAt = payload.retrievedAt ?? new Date().toISOString();
  const receipts: PersistedVaultMiningReceipt[] = [];
  const rejectedHits: RejectedVaultMiningHit[] = [];

  for (const hit of candidateResults(payload.rawResult)) {
    if (receipts.length >= maxResults) break;
    const record = normalizeHitRecord(hit);
    const sourcePath = extractSourcePath(record);
    const rawResultSummary = rawSummary(hit);
    if (!sourcePath) {
      rejectedHits.push({
        providerName: payload.providerName,
        sourceSystem: payload.sourceSystem,
        mcpServerName: payload.mcpServerName,
        toolName: payload.toolName,
        query: payload.query,
        reason: "missing sourcePath",
        rawResultSummary,
      });
      continue;
    }

    const excerpt = boundedText(
      pickString(record, ["excerpt", "snippet", "preview", "text", "content", "markdown", "body", "match"]),
    ) ?? "[No excerpt supplied by provider]";
    const lineStart = boundedOptionalNumber(record.lineStart ?? record.line_start ?? record.startLine ?? record.start_line ?? record.line);
    const lineEnd = boundedOptionalNumber(record.lineEnd ?? record.line_end ?? record.endLine ?? record.end_line) ?? lineStart;
    const title = boundedText(pickString(record, ["title", "name", "basename", "heading"]), 160);
    const sourceUri = boundedText(pickString(record, ["sourceUri", "source_uri", "uri", "url"]), 500);
    const hash = contentHash({
      sourceSystem: payload.sourceSystem,
      providerName: payload.providerName,
      toolName: payload.toolName,
      query: payload.query,
      sourcePath,
      sourceUri,
      lineStart,
      lineEnd,
      excerpt,
    });

    receipts.push({
      receiptId: `LVR-${hash.slice(0, 16)}`,
      sourceSystem: payload.sourceSystem,
      providerName: payload.providerName,
      mcpServerName: payload.mcpServerName,
      toolName: payload.toolName,
      query: payload.query,
      sourcePath,
      sourceUri,
      lineStart,
      lineEnd,
      title,
      excerpt,
      retrievedAt,
      hash,
      verified: false,
      rawResultSummary,
    });
  }

  return dedupeReceipts({ receipts, rejectedHits });
}

function dedupeReceipts(input: { receipts: PersistedVaultMiningReceipt[]; rejectedHits: RejectedVaultMiningHit[] }) {
  const seen = new Set<string>();
  const receipts = input.receipts.filter((receipt) => {
    if (seen.has(receipt.hash)) return false;
    seen.add(receipt.hash);
    return true;
  });
  return { receipts, rejectedHits: input.rejectedHits };
}

export function validateVaultMiningOverrides(overrides: unknown): VaultMiningProviderOverrides | undefined {
  if (overrides === undefined) return undefined;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw badRequest("providerOverrides must be an object");
  }
  const input = overrides as Record<string, unknown>;
  const output: VaultMiningProviderOverrides = {};
  for (const provider of ["qmd", "obsidian"] as const) {
    if (input[provider] === undefined) continue;
    if (!input[provider] || typeof input[provider] !== "object" || Array.isArray(input[provider])) {
      throw badRequest(`${provider} override must be an object`);
    }
    const record = input[provider] as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (!["serverName", "searchToolName", "readToolName"].includes(key) || (provider === "qmd" && key === "readToolName")) {
        throw badRequest(`invalid ${provider} override field: ${key}`);
      }
      if (value !== undefined && typeof value !== "string") {
        throw badRequest(`${provider}.${key} must be a string`);
      }
    }
    const serverName = typeof record.serverName === "string" ? record.serverName.trim() : undefined;
    const searchToolName = typeof record.searchToolName === "string" ? record.searchToolName.trim() : undefined;
    const readToolName = typeof record.readToolName === "string" ? record.readToolName.trim() : undefined;
    if (searchToolName) assertAllowedLegalMcpTool(provider, searchToolName);
    if (provider === "obsidian" && readToolName) assertAllowedLegalMcpTool(provider, readToolName);
    output[provider] = {
      ...(serverName ? { serverName } : {}),
      ...(searchToolName ? { searchToolName } : {}),
      ...(provider === "obsidian" && readToolName ? { readToolName } : {}),
    };
  }
  return output;
}

export function buildVaultMiningQueries(request: VaultMiningRequest): string[] {
  let explicitQueries: string[] = [];
  if (request.queries !== undefined) {
    if (!Array.isArray(request.queries)) {
      throw badRequest("queries must be an array of non-empty strings");
    }
    explicitQueries = request.queries.map((value) => {
      if (typeof value !== "string" || !value.trim()) {
        throw badRequest("queries must contain only non-empty strings");
      }
      return value;
    });
  }
  const rawQueries = [
    request.matterName,
    request.focus,
    request.vaultScope,
    request.sourceScope,
    request.sourceQuery,
    ...explicitQueries,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const maxQueries = validateBoundedInteger(request.maxQueries, "maxQueries", DEFAULT_MAX_QUERIES, HARD_MAX_QUERIES);
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of rawQueries) {
    const query = boundedText(raw, MAX_QUERY_CHARS);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maxQueries) break;
  }
  return queries.length > 0 ? queries : ["counter-lawsuit source receipts"];
}

function validateBoundedInteger(value: unknown, name: string, defaultValue: number, hardMax: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > hardMax) {
    throw badRequest(`${name} must be an integer between 1 and ${hardMax}`);
  }
  return value;
}

async function defaultMcpClientFactory(params: { rootDir: string; provider: LegalMcpProviderName; serverName?: string }) {
  const resolved = await createLegalMcpClientFromProjectConfig(params);
  if (!resolved) return null;
  return {
    client: resolved.client,
    mcpServerName: resolved.server.name,
    redactedConfig: resolved.server.redactedConfig as unknown as Record<string, unknown>,
  };
}

function isSearchTool(provider: LegalMcpProviderName, toolName: string): boolean {
  if (!isAllowedLegalMcpTool(provider, toolName)) return false;
  if (provider === "qmd") return true;
  return ["search", "obsidian_search", "obsidian.search", "simple_search", "obsidian_simple_search"].includes(toolName);
}

function selectTool(provider: LegalMcpProviderName, tools: LegalMcpTool[], overrideName?: string): string | undefined {
  if (overrideName) {
    assertAllowedLegalMcpTool(provider, overrideName);
    return tools.some((tool) => tool.name === overrideName) && isSearchTool(provider, overrideName) ? overrideName : undefined;
  }
  return tools.find((tool) => isSearchTool(provider, tool.name))?.name;
}

async function runMcpProvider(params: {
  rootDir: string;
  provider: LegalMcpProviderName;
  sourceSystem: VaultMiningSourceSystem;
  queries: string[];
  maxResults: number;
  overrides?: VaultMiningProviderOverrides["qmd"] | VaultMiningProviderOverrides["obsidian"];
  factory: LegalVaultMcpClientFactory;
  now: () => Date;
}): Promise<{ receipts: PersistedVaultMiningReceipt[]; rejectedHits: RejectedVaultMiningHit[]; diagnostic: VaultMiningProviderDiagnostic; unavailable: boolean }> {
  const providerName = params.provider;
  const resolved = await params.factory({ rootDir: params.rootDir, provider: params.provider, serverName: params.overrides?.serverName });
  if (!resolved) {
    return {
      receipts: [],
      rejectedHits: [],
      unavailable: true,
      diagnostic: {
        providerName,
        sourceSystem: params.sourceSystem,
        status: "unavailable",
        message: `${providerName} MCP server is not configured or unavailable`,
      },
    };
  }

  const allReceipts: PersistedVaultMiningReceipt[] = [];
  const allRejected: RejectedVaultMiningHit[] = [];
  try {
    const tools = await resolved.client.listTools();
    const toolName = selectTool(params.provider, tools, params.overrides?.searchToolName);
    if (!toolName) {
      await resolved.client.close();
      return {
        receipts: [],
        rejectedHits: [],
        unavailable: true,
        diagnostic: {
          providerName,
          sourceSystem: params.sourceSystem,
          mcpServerName: resolved.mcpServerName,
          status: "unavailable",
          message: `${providerName} MCP server has no read-only search tool allowed for legal vault mining`,
          redactedConfig: resolved.redactedConfig,
        },
      };
    }

    for (const query of params.queries) {
      const rawResult = await resolved.client.callTool(toolName, { query, limit: params.maxResults });
      const normalized = normalizeVaultMiningProviderPayload({
        providerName,
        sourceSystem: params.sourceSystem,
        mcpServerName: resolved.mcpServerName,
        toolName,
        query,
        rawResult,
        retrievedAt: params.now().toISOString(),
      }, { maxResults: params.maxResults });
      allReceipts.push(...normalized.receipts);
      allRejected.push(...normalized.rejectedHits);
    }
    await resolved.client.close();
    const deduped = dedupeReceipts({ receipts: allReceipts, rejectedHits: allRejected });
    return {
      ...deduped,
      unavailable: false,
      diagnostic: {
        providerName,
        sourceSystem: params.sourceSystem,
        mcpServerName: resolved.mcpServerName,
        status: deduped.rejectedHits.length > 0 ? "partial" : "available",
        message: `${providerName} MCP vault mining completed with ${deduped.receipts.length} accepted receipt(s)`,
        toolName,
        redactedConfig: resolved.redactedConfig,
        acceptedCount: deduped.receipts.length,
        rejectedCount: deduped.rejectedHits.length,
        rejectedHits: deduped.rejectedHits,
      },
    };
  } catch (error) {
    await resolved.client.close().catch(() => undefined);
    return {
      receipts: [],
      rejectedHits: [],
      unavailable: true,
      diagnostic: {
        providerName,
        sourceSystem: params.sourceSystem,
        mcpServerName: resolved.mcpServerName,
        status: "error",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
        redactedConfig: resolved.redactedConfig,
      },
    };
  }
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function findResearchMemoTask(tasks: Task[]): Task | undefined {
  return tasks.find((task) => task.sourceMetadata?.workflowStage === "research-memo");
}

function getRootDir(taskStore: MineCounterLawsuitVaultSourcesOptions["taskStore"]): string {
  return typeof taskStore.getRootDir === "function" ? taskStore.getRootDir() : process.cwd();
}

function mergeLaunchInput(runId: string, launchInput?: CounterLawsuitWorkflowLaunchInput, request?: Partial<VaultMiningRequest>): VaultMiningRequest {
  const overrides = validateVaultMiningOverrides(request?.providerOverrides);
  return {
    runId,
    matterName: typeof launchInput?.matterName === "string" ? launchInput.matterName : request?.matterName,
    focus: typeof launchInput?.focus === "string" ? launchInput.focus : request?.focus,
    vaultScope: typeof launchInput?.vaultScope === "string" ? launchInput.vaultScope : request?.vaultScope,
    sourceScope: typeof launchInput?.sourceScope === "string" ? launchInput.sourceScope : request?.sourceScope,
    sourceQuery: typeof launchInput?.sourceQuery === "string" ? launchInput.sourceQuery : request?.sourceQuery,
    queries: request?.queries,
    maxQueries: request?.maxQueries,
    maxResultsPerProvider: request?.maxResultsPerProvider,
    providerOverrides: overrides,
  };
}

function memoryResultsToRaw(results: MemorySearchResult[]): unknown[] {
  return results.map((result) => ({
    sourcePath: result.path,
    lineStart: result.lineStart,
    lineEnd: result.lineEnd,
    excerpt: result.snippet,
    title: result.path,
    score: result.score,
    backend: result.backend,
  }));
}

async function runQmdFallback(params: {
  rootDir: string;
  queries: string[];
  maxResults: number;
  searchProjectMemoryFn: typeof searchProjectMemory;
  now: () => Date;
}): Promise<{ receipts: PersistedVaultMiningReceipt[]; rejectedHits: RejectedVaultMiningHit[]; diagnostic: VaultMiningProviderDiagnostic }> {
  const allReceipts: PersistedVaultMiningReceipt[] = [];
  const allRejected: RejectedVaultMiningHit[] = [];
  try {
    for (const query of params.queries) {
      const results = await params.searchProjectMemoryFn(params.rootDir, { query, limit: params.maxResults }, { memoryBackendType: "qmd" });
      const normalized = normalizeVaultMiningProviderPayload({
        providerName: "qmd-memory-fallback",
        sourceSystem: "qmd-memory-fallback",
        toolName: "searchProjectMemory",
        query,
        rawResult: memoryResultsToRaw(results),
        retrievedAt: params.now().toISOString(),
      }, { maxResults: params.maxResults });
      allReceipts.push(...normalized.receipts);
      allRejected.push(...normalized.rejectedHits);
    }
    const deduped = dedupeReceipts({ receipts: allReceipts, rejectedHits: allRejected });
    return {
      ...deduped,
      diagnostic: {
        providerName: "qmd-memory-fallback",
        sourceSystem: "qmd-memory-fallback",
        status: deduped.receipts.length > 0 ? "partial" : "unavailable",
        message: `QMD MCP unavailable; used bounded project-memory fallback with ${deduped.receipts.length} accepted receipt(s)`,
        toolName: "searchProjectMemory",
        acceptedCount: deduped.receipts.length,
        rejectedCount: deduped.rejectedHits.length,
        rejectedHits: deduped.rejectedHits,
      },
    };
  } catch (error) {
    return {
      receipts: [],
      rejectedHits: [],
      diagnostic: {
        providerName: "qmd-memory-fallback",
        sourceSystem: "qmd-memory-fallback",
        status: "error",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

function buildReceiptsDocument(params: {
  result: Omit<VaultMiningResult, "status" | "receiptCount" | "receiptsDocumentKey">;
  receipts: PersistedVaultMiningReceipt[];
  researchRunId?: string;
}): string {
  return `# Vault-mining receipts

These mined materials are source-linked discovery receipts only. They are not legally verified, not citation-validated, and not promoted for filing until later source/citation verification, opposing-counsel red-team, lineage, and qualified human review gates pass.

- Research run ID: ${params.researchRunId ?? "not persisted"}
- Queries: ${params.result.queries.join(" | ")}
- Accepted receipts: ${params.receipts.length}
- Rejected hits: ${params.result.rejectedHits.length}

## Accepted receipts
${params.receipts.map((receipt) => `- ${receipt.receiptId} — ${receipt.sourceSystem} — ${receipt.sourcePath} — verified: false`).join("\n") || "None"}

## Machine-readable manifest

\`\`\`json
${JSON.stringify({
    safetyNotice: "Source-linked only; not legally verified, not citation-validated, not promoted for filing.",
    researchRunId: params.researchRunId,
    queries: params.result.queries,
    receipts: params.receipts,
    rejectedHits: params.result.rejectedHits,
    providerDiagnostics: params.result.providerDiagnostics,
  }, null, 2)}
\`\`\`
`;
}

function buildStatusDocument(result: VaultMiningResult): string {
  return `# Vault-mining status

Vault mining status: ${result.status}

Mined material is source-linked only. It is not legally verified, not citation-validated, and not promoted for filing.

- Research run ID: ${result.researchRunId ?? "none"}
- Receipt count: ${result.receiptCount}
- Providers:
${result.providerDiagnostics.map((diagnostic) => `  - ${diagnostic.providerName}: ${diagnostic.status} — ${diagnostic.message}`).join("\n")}
`;
}

function resultStatus(diagnostics: VaultMiningProviderDiagnostic[], receiptCount: number): VaultMiningResult["status"] {
  if (receiptCount > 0 && diagnostics.some((diagnostic) => diagnostic.status === "unavailable" || diagnostic.status === "error" || diagnostic.status === "partial")) return "partial";
  if (receiptCount > 0) return "completed";
  if (diagnostics.every((diagnostic) => diagnostic.status === "unavailable" || diagnostic.status === "error")) return "unavailable";
  return "partial";
}

function persistResearchRun(params: {
  researchStore: Pick<ResearchStore, "createRun" | "updateStatus">;
  runId: string;
  queries: string[];
  receipts: PersistedVaultMiningReceipt[];
  diagnostics: VaultMiningProviderDiagnostic[];
}): ResearchRun {
  const sources: ResearchSource[] = params.receipts.map((receipt) => ({
    id: receipt.receiptId,
    type: "local",
    reference: receipt.sourcePath,
    title: receipt.title ?? receipt.sourcePath,
    excerpt: receipt.excerpt,
    content: receipt.excerpt,
    status: "completed",
    fetchedAt: receipt.retrievedAt,
    metadata: { vaultMiningReceipt: receipt },
  }));
  const run = params.researchStore.createRun({
    query: params.queries.join(" | "),
    topic: "Counter-lawsuit vault mining receipts",
    trigger: VAULT_MINING_RESEARCH_TRIGGER,
    sources,
    tags: ["legal-workflow", "counter-lawsuit", "vault-mining"],
    metadata: {
      workflowRunId: params.runId,
      providerDiagnostics: params.diagnostics,
      safetyNotice: "Receipts are source-linked only; verified is false; no legal authority or citation validation has occurred.",
    },
    lifecycle: { maxAttempts: 1 },
  });
  const now = new Date().toISOString();
  params.researchStore.updateStatus(run.id, "running", { startedAt: now });
  params.researchStore.updateStatus(run.id, "completed", { completedAt: now });
  return { ...run, status: "completed", startedAt: now, completedAt: now };
}

export async function mineCounterLawsuitVaultSources(options: MineCounterLawsuitVaultSourcesOptions): Promise<VaultMiningResult> {
  const request = mergeLaunchInput(options.runId, options.launchInput, options.request);
  const queries = buildVaultMiningQueries(request);
  const maxResults = validateBoundedInteger(request.maxResultsPerProvider, "maxResultsPerProvider", DEFAULT_MAX_RESULTS_PER_PROVIDER, HARD_MAX_RESULTS_PER_PROVIDER);
  const rootDir = getRootDir(options.taskStore);
  const now = options.now ?? (() => new Date());
  const tasks = (await options.taskStore.listTasks({ includeArchived: true } as never))
    .filter((task) => taskMatchesRun(task, options.runId));
  if (tasks.length === 0) throw notFound(`Legal workflow run ${options.runId} not found`);
  const researchMemoTask = findResearchMemoTask(tasks);
  if (!researchMemoTask) throw notFound(`Legal workflow run ${options.runId} has no research-memo stage task`);

  const factory = options.mcpClientFactory ?? defaultMcpClientFactory;
  const diagnostics: VaultMiningProviderDiagnostic[] = [];
  const rejectedHits: RejectedVaultMiningHit[] = [];
  const receipts: PersistedVaultMiningReceipt[] = [];

  const qmd = await runMcpProvider({
    rootDir,
    provider: "qmd",
    sourceSystem: "qmd-mcp",
    queries,
    maxResults,
    overrides: request.providerOverrides?.qmd,
    factory,
    now,
  });
  diagnostics.push(qmd.diagnostic);
  rejectedHits.push(...qmd.rejectedHits);
  receipts.push(...qmd.receipts);
  if (qmd.unavailable) {
    const fallback = await runQmdFallback({
      rootDir,
      queries,
      maxResults,
      searchProjectMemoryFn: options.searchProjectMemoryFn ?? searchProjectMemory,
      now,
    });
    diagnostics.push(fallback.diagnostic);
    rejectedHits.push(...fallback.rejectedHits);
    receipts.push(...fallback.receipts);
  }

  const obsidian = await runMcpProvider({
    rootDir,
    provider: "obsidian",
    sourceSystem: "obsidian-mcp",
    queries,
    maxResults,
    overrides: request.providerOverrides?.obsidian,
    factory,
    now,
  });
  diagnostics.push(obsidian.diagnostic);
  rejectedHits.push(...obsidian.rejectedHits);
  receipts.push(...obsidian.receipts);

  const deduped = dedupeReceipts({ receipts, rejectedHits });
  const researchRun = persistResearchRun({
    researchStore: options.taskStore.getResearchStore(),
    runId: options.runId,
    queries,
    receipts: deduped.receipts,
    diagnostics,
  });

  const result: VaultMiningResult = {
    runId: options.runId,
    status: resultStatus(diagnostics, deduped.receipts.length),
    researchRunId: researchRun.id,
    receiptCount: deduped.receipts.length,
    receipts: deduped.receipts,
    receiptsDocumentKey: VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
    statusDocumentKey: VAULT_MINING_STATUS_DOCUMENT_KEY,
    providerDiagnostics: diagnostics,
    rejectedHits: deduped.rejectedHits,
    queries,
  };

  await options.taskStore.upsertTaskDocument(researchMemoTask.id, {
    key: VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
    content: buildReceiptsDocument({ result, receipts: deduped.receipts, researchRunId: researchRun.id }),
    author: "fusion-legal-vault-mining",
    metadata: {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: options.runId,
      researchRunId: researchRun.id,
      receipts: deduped.receipts,
      rejectedHits: deduped.rejectedHits,
      providerDiagnostics: diagnostics,
      safetyNotice: "Source-linked only; not legally verified, not citation-validated, not promoted for filing.",
    },
  });

  await options.taskStore.upsertTaskDocument(researchMemoTask.id, {
    key: VAULT_MINING_STATUS_DOCUMENT_KEY,
    content: buildStatusDocument(result),
    author: "fusion-legal-vault-mining",
    metadata: {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: options.runId,
      researchRunId: researchRun.id,
      status: result.status,
      receiptCount: result.receiptCount,
      providerDiagnostics: diagnostics,
    },
  });

  const existingStageDoc = await options.taskStore.getTaskDocument(researchMemoTask.id, COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY).catch(() => null as TaskDocument | null);
  if (existingStageDoc && !existingStageDoc.content.includes(VAULT_MINING_RECEIPTS_DOCUMENT_KEY)) {
    await options.taskStore.upsertTaskDocument(researchMemoTask.id, {
      key: COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY,
      content: `${existingStageDoc.content}\n\n## Vault-mining source manifest\nRead task document key \`${VAULT_MINING_RECEIPTS_DOCUMENT_KEY}\` first. It is the required first source manifest for downstream research memo work. Treat every receipt as source-linked but unverified until later safety gates pass.`,
      author: "fusion-legal-vault-mining",
      metadata: existingStageDoc.metadata,
    });
  }

  return result;
}

export async function deriveVaultMiningStatusForRun(params: {
  taskStore: Pick<TaskStore, "listTasks" | "getTaskDocument">;
  runId: string;
}): Promise<{
  status: VaultMiningResult["status"] | "not-run";
  researchRunId?: string;
  receiptCount: number;
  receiptsDocumentKey?: string;
  statusDocumentKey?: string;
  providerDiagnostics: VaultMiningProviderDiagnostic[];
}> {
  const tasks = (await params.taskStore.listTasks({ includeArchived: true } as never)).filter((task) => taskMatchesRun(task, params.runId));
  const researchMemoTask = findResearchMemoTask(tasks);
  if (!researchMemoTask) {
    return { status: "not-run", receiptCount: 0, providerDiagnostics: [] };
  }
  const doc = await params.taskStore.getTaskDocument(researchMemoTask.id, VAULT_MINING_RECEIPTS_DOCUMENT_KEY).catch(() => null);
  const statusDoc = await params.taskStore.getTaskDocument(researchMemoTask.id, VAULT_MINING_STATUS_DOCUMENT_KEY).catch(() => null);
  if (!doc) {
    return { status: "not-run", receiptCount: 0, providerDiagnostics: [] };
  }
  const metadata = doc.metadata ?? {};
  const receipts = Array.isArray(metadata.receipts) ? metadata.receipts as PersistedVaultMiningReceipt[] : [];
  const providerDiagnostics = Array.isArray(metadata.providerDiagnostics) ? metadata.providerDiagnostics as VaultMiningProviderDiagnostic[] : [];
  const status = statusDoc?.metadata?.status === "completed" || statusDoc?.metadata?.status === "partial" || statusDoc?.metadata?.status === "unavailable" || statusDoc?.metadata?.status === "failed"
    ? statusDoc.metadata.status as VaultMiningResult["status"]
    : resultStatus(providerDiagnostics, receipts.length);
  return {
    status,
    researchRunId: typeof metadata.researchRunId === "string" ? metadata.researchRunId : undefined,
    receiptCount: receipts.length,
    receiptsDocumentKey: VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
    statusDocumentKey: statusDoc ? VAULT_MINING_STATUS_DOCUMENT_KEY : undefined,
    providerDiagnostics,
  };
}
