import { createHash } from "node:crypto";
import type { TaskDocument } from "@fusion/core";

export const COURTLISTENER_DEFAULT_BASE_URL = "https://www.courtlistener.com/api/rest/v4";
export const COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY = "courtlistener-authority-validation";
export const COURTLISTENER_STATUS_DOCUMENT_KEY = "courtlistener-status";
export const COURTLISTENER_RESEARCH_TRIGGER = "legal-counter-lawsuit-courtlistener-validation";
export const COURTLISTENER_SAFETY_NOTICE = "CourtListener validation is authority and citation lookup evidence only. It is not legal advice, not good-law verification, not Shepardizing, not filing-format citation checking, not filing readiness, and not attorney judgment. Results are not promoted for filing.";

export type CourtListenerInputType = "citation" | "query";
export type CourtListenerAuthorityStatus = "matched" | "not-found" | "ambiguous" | "unavailable";
export type CourtListenerValidationStatus = "completed" | "partial" | "unavailable" | "no-candidates" | "failed";

export interface CourtListenerCitationLookupInput {
  citation: string;
  maxResults?: number;
}

export interface CourtListenerSearchInput {
  query: string;
  maxResults?: number;
}

export interface CourtListenerClient {
  lookupCitation(input: CourtListenerCitationLookupInput): Promise<unknown>;
  searchAuthorities(input: CourtListenerSearchInput): Promise<unknown>;
}

export interface CourtListenerAuthorityCandidate {
  input: string;
  inputType: CourtListenerInputType;
  source: string;
}

export interface CourtListenerAuthorityValidationRequest {
  runId?: string;
  citations?: string[];
  queries?: string[];
  text?: string;
  launchFocus?: string;
  launchSourceQuery?: string;
  vaultReceipts?: Array<Record<string, unknown>>;
  stageDocuments?: TaskDocument[];
  maxCandidates?: number;
  maxResultsPerCandidate?: number;
}

export interface CourtListenerAuthorityValidationRecord {
  recordId: string;
  input: string;
  inputType: CourtListenerInputType;
  status: CourtListenerAuthorityStatus;
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
}

export interface RejectedCourtListenerCandidate {
  input: string;
  inputType?: CourtListenerInputType;
  source: string;
  reason: string;
}

export interface CourtListenerProviderDiagnostic {
  providerName: "courtlistener";
  status: "available" | "partial" | "unavailable" | "error" | "skipped";
  message: string;
  endpoint?: string;
  candidate?: string;
  acceptedCount?: number;
  rejectedCount?: number;
}

export interface CourtListenerAuthorityValidationResult {
  runId?: string;
  status: CourtListenerValidationStatus;
  researchRunId?: string;
  candidateCount: number;
  validatedCount: number;
  unmatchedCount: number;
  candidates: CourtListenerAuthorityCandidate[];
  validationRecords: CourtListenerAuthorityValidationRecord[];
  rejectedCandidates: RejectedCourtListenerCandidate[];
  diagnostics: CourtListenerProviderDiagnostic[];
  authorityValidationDocumentKey: typeof COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY;
  statusDocumentKey?: typeof COURTLISTENER_STATUS_DOCUMENT_KEY;
  safetyNotice: typeof COURTLISTENER_SAFETY_NOTICE;
}

export interface CreateCourtListenerClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  paths?: {
    citationLookup?: string;
    search?: string;
  };
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CANDIDATES = 12;
const HARD_MAX_CANDIDATES = 25;
const DEFAULT_MAX_RESULTS_PER_CANDIDATE = 3;
const HARD_MAX_RESULTS_PER_CANDIDATE = 10;
const MAX_INPUT_CHARS = 300;
const MAX_TEXT_SCAN_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 700;
const TOKEN_RE = /["']?(?:authorization)["']?\s*[:=]\s*["']?bearer\s+[^"'\s,}]{8,}["']?|["']?(?:token|secret|api[_-]?key|password|credential|auth)["']?\s*[:=]\s*["']?[^"'\s,}]{8,}["']?|bearer\s+\S{8,}|Token\s+\S{8,}|(?:sk|pk|ghp|github_pat)[A-Za-z0-9_:\-.=+/]{8,}/gi;
const SECRET_FLAG_VALUE_RE = /(--[A-Za-z0-9_.-]*(?:token|secret|key|password|credential|auth)[A-Za-z0-9_.-]*)(\s+)(?:"[^"]+"|'[^']+'|\S+)/gi;
const TOKEN_KEY_RE = /(?:token|secret|api[_-]?key|password|credential|auth|authorization)/i;
const CITATION_RE = /\b\d{1,4}\s+(?:U\.S\.|S\.Ct\.|F\.?\s?\d?d|F\.\s?Supp\.?\s?\d?d|Cal\.?\s?\d?d|N\.Y\.?\s?\d?d|P\.?\s?\d?d|A\.?\s?\d?d|So\.?\s?\d?d)\s+\d{1,5}\b/g;

function redactSecrets(value: string): string {
  return value
    .replace(SECRET_FLAG_VALUE_RE, "$1$2[REDACTED]")
    .replace(TOKEN_RE, "[REDACTED]");
}

function boundedText(value: unknown, maxChars = MAX_INPUT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function boundedInteger(value: unknown, name: string, defaultValue: number, hardMax: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > hardMax) {
    throw new Error(`${name} must be an integer between 1 and ${hardMax}`);
  }
  return value;
}

function contentHash(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function safeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeEndpoint(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function tokenFromEnvironment(): string | undefined {
  return process.env.COURTLISTENER_API_TOKEN || process.env.COURTLISTENER_TOKEN || undefined;
}

export function createCourtListenerClient(options: CreateCourtListenerClientOptions = {}): CourtListenerClient {
  const baseUrl = safeUrl(options.baseUrl ?? COURTLISTENER_DEFAULT_BASE_URL);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = options.token ?? tokenFromEnvironment();
  const citationLookupPath = normalizeEndpoint(options.paths?.citationLookup ?? "/citation-lookup/");
  const searchPath = normalizeEndpoint(options.paths?.search ?? "/search/");

  async function request(path: string, init: RequestInit, endpointName: string): Promise<unknown> {
    if (!fetchImpl) throw new Error("fetch is not available for CourtListener requests");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Token ${token}`);

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`CourtListener ${endpointName} failed with HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`CourtListener ${endpointName} timed out`);
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`CourtListener ${endpointName} timed out`);
      }
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    lookupCitation(input) {
      const citation = boundedText(input.citation);
      if (!citation) throw new Error("citation is required");
      const maxResults = boundedInteger(input.maxResults, "maxResults", DEFAULT_MAX_RESULTS_PER_CANDIDATE, HARD_MAX_RESULTS_PER_CANDIDATE);
      return request(citationLookupPath, {
        method: "POST",
        body: JSON.stringify({ text: citation, citation, max_results: maxResults }),
      }, "citation lookup");
    },
    searchAuthorities(input) {
      const query = boundedText(input.query);
      if (!query) throw new Error("query is required");
      const maxResults = boundedInteger(input.maxResults, "maxResults", DEFAULT_MAX_RESULTS_PER_CANDIDATE, HARD_MAX_RESULTS_PER_CANDIDATE);
      const searchParams = new URLSearchParams();
      searchParams.set("q", query);
      searchParams.set("type", "o");
      searchParams.set("order_by", "score desc");
      searchParams.set("page_size", String(maxResults));
      return request(`${searchPath}?${searchParams.toString()}`, { method: "GET" }, "authority search");
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return boundedText(value, 500);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function nested(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) return value;
  }
  return undefined;
}

function extractResults(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return raw === undefined || raw === null ? [] : [raw];
  for (const key of ["results", "clusters", "opinions", "matches"] as const) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  if (Array.isArray(asRecord(record.result)?.results)) return asRecord(record.result)?.results as unknown[];
  return [record];
}

function summarizeRaw(raw: unknown): string {
  if (Array.isArray(raw)) return `array(${raw.length})`;
  if (!raw || typeof raw !== "object") return redactSecrets(`${typeof raw}(length=${String(raw).length})`).slice(0, MAX_SUMMARY_CHARS);
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => !TOKEN_KEY_RE.test(key)).slice(0, 8);
  const count = Array.isArray(record.results) ? record.results.length
    : Array.isArray(record.clusters) ? record.clusters.length
      : Array.isArray(record.opinions) ? record.opinions.length
        : Array.isArray(record.matches) ? record.matches.length
          : undefined;
  return redactSecrets(`object(keys=${keys.join(",")}${count !== undefined ? `, results=${count}` : ""})`).slice(0, MAX_SUMMARY_CHARS);
}

function hasAuthorityFields(record: Record<string, unknown>): boolean {
  return [
    "citation",
    "normalized_citation",
    "canonical_citation",
    "case_name",
    "caseName",
    "absolute_url",
    "cluster_id",
    "opinion_id",
    "court",
  ].some((key) => record[key] !== undefined);
}

function extractAuthorityMatches(raw: unknown): unknown[] {
  const wrappers = extractResults(raw);
  const matches: unknown[] = [];
  for (const wrapper of wrappers) {
    const record = asRecord(wrapper);
    if (!record) {
      if (wrapper !== undefined && wrapper !== null) matches.push(wrapper);
      continue;
    }

    let foundNested = false;
    for (const key of ["clusters", "opinions", "matches", "authorities"] as const) {
      if (Array.isArray(record[key])) {
        foundNested = true;
        matches.push(...record[key] as unknown[]);
      }
    }
    if (foundNested) continue;

    if (asRecord(record.cluster) || asRecord(record.opinion) || hasAuthorityFields(record)) {
      matches.push(record);
    }
  }
  return matches;
}

function candidateRecord(rawMatch: unknown): Record<string, unknown> {
  const record = asRecord(rawMatch) ?? { text: typeof rawMatch === "string" ? rawMatch : JSON.stringify(rawMatch) };
  const cluster = nested(record, ["cluster", "case"]);
  const opinion = nested(record, ["opinion"]);
  return { ...(cluster ?? {}), ...(opinion ?? {}), ...record };
}

function absoluteCourtListenerUrl(absoluteUrl?: string, courtListenerUrl?: string): string | undefined {
  if (courtListenerUrl?.startsWith("http")) return courtListenerUrl;
  if (absoluteUrl?.startsWith("http")) return absoluteUrl;
  const path = courtListenerUrl ?? absoluteUrl;
  if (path?.startsWith("/")) return `https://www.courtlistener.com${path}`;
  return undefined;
}

export function normalizeCourtListenerAuthorityRecord(params: {
  input: string;
  inputType: CourtListenerInputType;
  status: CourtListenerAuthorityStatus;
  rawResult?: unknown;
  retrievedAt?: string;
}): CourtListenerAuthorityValidationRecord {
  const retrievedAt = params.retrievedAt ?? new Date().toISOString();
  const first = extractAuthorityMatches(params.rawResult)[0];
  const record = candidateRecord(first);
  const cluster = nested(record, ["cluster"]);
  const opinion = nested(record, ["opinion"]);
  const normalizedCitation = pickString(record, ["citation", "normalized_citation", "canonical_citation", "cite", "citation_string"]);
  const caseName = pickString(record, ["caseName", "case_name", "caseNameShort", "case_name_short", "caption", "name"]);
  const court = pickString(record, ["court", "court_id", "courtName", "court_name"]) ?? pickString(cluster ?? {}, ["court", "court_id", "courtName", "court_name"]);
  const dateFiled = pickString(record, ["dateFiled", "date_filed", "date", "filed"]);
  const clusterId = pickString(record, ["cluster_id", "clusterId", "id"]) ?? pickString(cluster ?? {}, ["id"]);
  const opinionId = pickString(record, ["opinion_id", "opinionId"]) ?? pickString(opinion ?? {}, ["id"]);
  const absoluteUrl = pickString(record, ["absolute_url", "absoluteUrl"]) ?? pickString(cluster ?? {}, ["absolute_url", "absoluteUrl"]);
  const courtListenerUrl = absoluteCourtListenerUrl(absoluteUrl, pickString(record, ["courtListenerUrl", "court_listener_url", "url", "download_url"]));
  const hash = contentHash({
    input: params.input,
    inputType: params.inputType,
    status: params.status,
    normalizedCitation,
    caseName,
    court,
    dateFiled,
    clusterId,
    opinionId,
    courtListenerUrl,
    absoluteUrl,
  });

  return {
    recordId: `CLV-${hash.slice(0, 16)}`,
    input: params.input,
    inputType: params.inputType,
    status: params.status,
    normalizedCitation,
    caseName,
    court,
    dateFiled,
    clusterId,
    opinionId,
    courtListenerUrl,
    absoluteUrl,
    retrievedAt,
    hash,
    source: "courtlistener",
    legalConclusionVerified: false,
    promoted: false,
    rawResultSummary: summarizeRaw(params.rawResult),
  };
}

function pushCandidate(params: {
  candidates: CourtListenerAuthorityCandidate[];
  rejected: RejectedCourtListenerCandidate[];
  value: unknown;
  inputType: CourtListenerInputType;
  source: string;
  seen: Set<string>;
  maxCandidates: number;
}): void {
  const input = boundedText(params.value);
  if (!input) return;
  if (input.length < 3) {
    params.rejected.push({ input, inputType: params.inputType, source: params.source, reason: "candidate too short" });
    return;
  }
  const key = `${params.inputType}:${input.toLowerCase()}`;
  if (params.seen.has(key)) return;
  params.seen.add(key);
  if (params.candidates.length >= params.maxCandidates) {
    params.rejected.push({ input, inputType: params.inputType, source: params.source, reason: "candidate limit exceeded" });
    return;
  }
  params.candidates.push({ input, inputType: params.inputType, source: params.source });
}

export function extractCourtListenerAuthorityCandidates(request: CourtListenerAuthorityValidationRequest): {
  candidates: CourtListenerAuthorityCandidate[];
  rejectedCandidates: RejectedCourtListenerCandidate[];
} {
  const maxCandidates = boundedInteger(request.maxCandidates, "maxCandidates", DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES);
  const candidates: CourtListenerAuthorityCandidate[] = [];
  const rejectedCandidates: RejectedCourtListenerCandidate[] = [];
  const seen = new Set<string>();
  const push = (value: unknown, inputType: CourtListenerInputType, source: string) => pushCandidate({ candidates, rejected: rejectedCandidates, value, inputType, source, seen, maxCandidates });

  for (const citation of request.citations ?? []) push(citation, "citation", "explicit.citations");
  for (const query of request.queries ?? []) push(query, "query", "explicit.queries");
  push(request.launchFocus, "query", "launch.focus");
  push(request.launchSourceQuery, "query", "launch.sourceQuery");

  const scannedText = boundedText(request.text, MAX_TEXT_SCAN_CHARS);
  if (scannedText) {
    for (const match of scannedText.matchAll(CITATION_RE)) push(match[0], "citation", "explicit.text");
  }

  for (const receipt of request.vaultReceipts ?? []) {
    push(receipt.normalizedCitation ?? receipt.citation, "citation", "vault-mining-receipts");
    push(receipt.query, "query", "vault-mining-receipts");
    const excerpt = boundedText(receipt.excerpt, 1_200);
    if (!excerpt) continue;
    for (const match of excerpt.matchAll(CITATION_RE)) push(match[0], "citation", "vault-mining-receipts.excerpt");
  }

  for (const doc of request.stageDocuments ?? []) {
    const content = boundedText(doc.content, MAX_TEXT_SCAN_CHARS);
    if (!content) continue;
    for (const match of content.matchAll(CITATION_RE)) push(match[0], "citation", `stage-document.${doc.key}`);
  }

  return { candidates, rejectedCandidates };
}

function statusFromRaw(raw: unknown): CourtListenerAuthorityStatus {
  const count = extractAuthorityMatches(raw).length;
  if (count === 0) return "not-found";
  return count > 1 ? "ambiguous" : "matched";
}

export async function validateAuthorityCandidatesWithCourtListener(params: {
  client: CourtListenerClient;
  request: CourtListenerAuthorityValidationRequest;
  now?: () => Date;
}): Promise<CourtListenerAuthorityValidationResult> {
  const now = params.now ?? (() => new Date());
  const maxResults = boundedInteger(params.request.maxResultsPerCandidate, "maxResultsPerCandidate", DEFAULT_MAX_RESULTS_PER_CANDIDATE, HARD_MAX_RESULTS_PER_CANDIDATE);
  const { candidates, rejectedCandidates } = extractCourtListenerAuthorityCandidates(params.request);
  const validationRecords: CourtListenerAuthorityValidationRecord[] = [];
  const diagnostics: CourtListenerProviderDiagnostic[] = [];

  if (candidates.length === 0) {
    diagnostics.push({
      providerName: "courtlistener",
      status: "skipped",
      message: "No bounded citation or authority candidates were found for CourtListener lookup.",
      acceptedCount: 0,
      rejectedCount: rejectedCandidates.length,
    });
    return {
      runId: params.request.runId,
      status: "no-candidates",
      candidateCount: 0,
      validatedCount: 0,
      unmatchedCount: 0,
      candidates,
      validationRecords,
      rejectedCandidates,
      diagnostics,
      authorityValidationDocumentKey: COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
      statusDocumentKey: COURTLISTENER_STATUS_DOCUMENT_KEY,
      safetyNotice: COURTLISTENER_SAFETY_NOTICE,
    };
  }

  for (const candidate of candidates) {
    try {
      const raw = candidate.inputType === "citation"
        ? await params.client.lookupCitation({ citation: candidate.input, maxResults })
        : await params.client.searchAuthorities({ query: candidate.input, maxResults });
      const status = statusFromRaw(raw);
      validationRecords.push(normalizeCourtListenerAuthorityRecord({
        input: candidate.input,
        inputType: candidate.inputType,
        status,
        rawResult: raw,
        retrievedAt: now().toISOString(),
      }));
      diagnostics.push({
        providerName: "courtlistener",
        status: status === "matched" ? "available" : "partial",
        message: `CourtListener ${candidate.inputType} lookup returned ${status} for a bounded candidate.`,
        endpoint: candidate.inputType === "citation" ? "citation-lookup" : "search",
        candidate: candidate.input,
        acceptedCount: status === "matched" ? 1 : 0,
      });
    } catch (error) {
      validationRecords.push(normalizeCourtListenerAuthorityRecord({
        input: candidate.input,
        inputType: candidate.inputType,
        status: "unavailable",
        rawResult: { error: redactSecrets(error instanceof Error ? error.message : String(error)) },
        retrievedAt: now().toISOString(),
      }));
      diagnostics.push({
        providerName: "courtlistener",
        status: "error",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
        endpoint: candidate.inputType === "citation" ? "citation-lookup" : "search",
        candidate: candidate.input,
        acceptedCount: 0,
      });
    }
  }

  const validatedCount = validationRecords.filter((record) => record.status === "matched").length;
  const unmatchedCount = validationRecords.filter((record) => record.status === "not-found" || record.status === "unavailable" || record.status === "ambiguous").length;
  const status: CourtListenerValidationStatus = validatedCount > 0 && unmatchedCount === 0 ? "completed"
    : validatedCount > 0 ? "partial"
      : validationRecords.every((record) => record.status === "unavailable") ? "unavailable"
        : "partial";

  return {
    runId: params.request.runId,
    status,
    candidateCount: candidates.length,
    validatedCount,
    unmatchedCount,
    candidates,
    validationRecords,
    rejectedCandidates,
    diagnostics,
    authorityValidationDocumentKey: COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
    statusDocumentKey: COURTLISTENER_STATUS_DOCUMENT_KEY,
    safetyNotice: COURTLISTENER_SAFETY_NOTICE,
  };
}
