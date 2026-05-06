import { describe, expect, it, vi } from "vitest";
import {
  COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
  createCourtListenerClient,
  extractCourtListenerAuthorityCandidates,
  normalizeCourtListenerAuthorityRecord,
  validateAuthorityCandidatesWithCourtListener,
  type CourtListenerClient,
} from "../legal-courtlistener.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

class FakeCourtListenerClient implements CourtListenerClient {
  constructor(private readonly raw: unknown, private readonly fail = false) {}
  citationCalls: unknown[] = [];
  searchCalls: unknown[] = [];
  async lookupCitation(input: any): Promise<unknown> {
    this.citationCalls.push(input);
    if (this.fail) throw new Error("provider token=super-secret-token timed out");
    return this.raw;
  }
  async searchAuthorities(input: any): Promise<unknown> {
    this.searchCalls.push(input);
    if (this.fail) throw new Error("provider token=super-secret-token timed out");
    return this.raw;
  }
}

describe("CourtListener API client", () => {
  it("adds auth header only when a token is configured", async () => {
    const fetchWithToken = vi.fn(async () => jsonResponse({ results: [] }));
    const authed = createCourtListenerClient({ baseUrl: "https://court.test/api", token: "cl-token", fetchImpl: fetchWithToken as unknown as typeof fetch });
    await authed.lookupCitation({ citation: "410 U.S. 113" });
    expect(fetchWithToken).toHaveBeenCalledTimes(1);
    const authedInit = fetchWithToken.mock.calls[0][1] as RequestInit;
    expect(new Headers(authedInit.headers).get("Authorization")).toBe("Token cl-token");

    const fetchWithoutToken = vi.fn(async () => jsonResponse({ results: [] }));
    const anonymous = createCourtListenerClient({ baseUrl: "https://court.test/api", token: "", fetchImpl: fetchWithoutToken as unknown as typeof fetch });
    await anonymous.searchAuthorities({ query: "Roe v Wade" });
    const anonymousInit = fetchWithoutToken.mock.calls[0][1] as RequestInit;
    expect(new Headers(anonymousInit.headers).has("Authorization")).toBe(false);
  });

  it("uses citation lookup and search endpoints with injectable paths", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ citation: "410 U.S. 113" }] }));
    const client = createCourtListenerClient({
      baseUrl: "https://court.test/api/rest/v4/",
      fetchImpl: fetchMock as unknown as typeof fetch,
      paths: { citationLookup: "/lookup-test/", search: "/search-test/" },
    });

    await client.lookupCitation({ citation: "410 U.S. 113", maxResults: 1 });
    await client.searchAuthorities({ query: "Roe v Wade", maxResults: 2 });

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://court.test/api/rest/v4/lookup-test/");
    expect(String(fetchMock.mock.calls[1][0])).toContain("https://court.test/api/rest/v4/search-test/?q=Roe+v+Wade");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ text: "410 U.S. 113", max_results: 1 });
  });

  it("surfaces bounded timeout errors without leaking tokens", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("AbortError token=super-secret-value"), { name: "AbortError" })));
      });
      return jsonResponse({});
    });
    const client = createCourtListenerClient({ baseUrl: "https://court.test", token: "secret-token-value", timeoutMs: 1, fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(client.lookupCitation({ citation: "410 U.S. 113" })).rejects.toThrow(/timed out/);
    await expect(client.lookupCitation({ citation: "410 U.S. 113" })).rejects.not.toThrow(/secret-token-value/);
  });
});

describe("CourtListener authority normalization", () => {
  it("normalizes citation lookup matches into persisted-safe records", () => {
    const record = normalizeCourtListenerAuthorityRecord({
      input: "410 U.S. 113",
      inputType: "citation",
      status: "matched",
      retrievedAt: "2026-05-06T00:00:00.000Z",
      rawResult: { results: [{ citation: "410 U.S. 113", case_name: "Roe v. Wade", court: "scotus", date_filed: "1973-01-22", cluster_id: 108713, opinion_id: 123, absolute_url: "/opinion/108713/roe-v-wade/", token: "super-secret-token" }] },
    });

    expect(record).toMatchObject({
      input: "410 U.S. 113",
      inputType: "citation",
      status: "matched",
      normalizedCitation: "410 U.S. 113",
      caseName: "Roe v. Wade",
      court: "scotus",
      dateFiled: "1973-01-22",
      clusterId: "108713",
      opinionId: "123",
      courtListenerUrl: "https://www.courtlistener.com/opinion/108713/roe-v-wade/",
      source: "courtlistener",
      legalConclusionVerified: false,
      promoted: false,
    });
    expect(record.recordId).toMatch(/^CLV-/);
    expect(record.hash).toHaveLength(64);
    expect(record.rawResultSummary).not.toContain("super-secret-token");
  });

  it("redacts standalone token-like CLI flags in raw summaries", () => {
    const record = normalizeCourtListenerAuthorityRecord({
      input: "1 U.S. 1",
      inputType: "citation",
      status: "unavailable",
      rawResult: { error: "courtlistener --auth-token super-secret-value failed" },
    });
    expect(record.rawResultSummary).not.toContain("super-secret-value");
  });

  it("treats empty citation lookup wrappers as not found and multi-cluster wrappers as ambiguous", async () => {
    const emptyWrapper = await validateAuthorityCandidatesWithCourtListener({
      client: new FakeCourtListenerClient([{ citation: "1 U.S. 1", clusters: [] }]),
      request: { citations: ["1 U.S. 1"] },
    });
    expect(emptyWrapper.validationRecords[0].status).toBe("not-found");

    const multiCluster = await validateAuthorityCandidatesWithCourtListener({
      client: new FakeCourtListenerClient([{ citation: "1 U.S. 1", clusters: [{ case_name: "Left" }, { case_name: "Right" }] }]),
      request: { citations: ["1 U.S. 1"] },
    });
    expect(multiCluster.validationRecords[0].status).toBe("ambiguous");
    expect(multiCluster.validatedCount).toBe(0);
  });

  it("keeps deterministic hashes for equivalent authority records", () => {
    const rawResult = { results: [{ citation: "123 F.3d 456", case_name: "Acme v. Example" }] };
    const left = normalizeCourtListenerAuthorityRecord({ input: "123 F.3d 456", inputType: "citation", status: "matched", retrievedAt: "a", rawResult });
    const right = normalizeCourtListenerAuthorityRecord({ input: "123 F.3d 456", inputType: "citation", status: "matched", retrievedAt: "b", rawResult });
    expect(left.hash).toBe(right.hash);
    expect(left.recordId).toBe(right.recordId);
  });

  it("extracts bounded candidates from explicit inputs, text, vault receipts, and stage documents", () => {
    const result = extractCourtListenerAuthorityCandidates({
      citations: ["410 U.S. 113"],
      queries: ["California anti-SLAPP retaliation"],
      text: "See 123 F.3d 456 and then repeated 123 F.3d 456.",
      vaultReceipts: [{ query: "vault authority", excerpt: "Receipt cites 555 F. Supp. 2d 12." }],
      stageDocuments: [{ key: "research-memo", content: "Draft note cites 999 U.S. 1." } as any],
      maxCandidates: 6,
    });

    expect(result.candidates.map((candidate) => candidate.input)).toEqual([
      "410 U.S. 113",
      "California anti-SLAPP retaliation",
      "123 F.3d 456",
      "vault authority",
      "555 F. Supp. 2d 12",
      "999 U.S. 1",
    ]);
  });

  it("bounds candidates and records rejected overflow", () => {
    const result = extractCourtListenerAuthorityCandidates({
      citations: ["1 U.S. 1", "2 U.S. 2", "3 U.S. 3"],
      maxCandidates: 2,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.rejectedCandidates).toEqual([{ input: "3 U.S. 3", inputType: "citation", source: "explicit.citations", reason: "candidate limit exceeded" }]);
  });
});

describe("CourtListener authority validation service", () => {
  it("validates citation and query candidates while preserving no-legal-conclusion defaults", async () => {
    const client = new FakeCourtListenerClient({ results: [{ citation: "410 U.S. 113", case_name: "Roe v. Wade" }] });
    const result = await validateAuthorityCandidatesWithCourtListener({
      client,
      request: { runId: "CLW-1", citations: ["410 U.S. 113"], queries: ["Roe v Wade"], maxResultsPerCandidate: 1 },
      now: () => new Date("2026-05-06T00:00:00.000Z"),
    });

    expect(client.citationCalls).toEqual([{ citation: "410 U.S. 113", maxResults: 1 }]);
    expect(client.searchCalls).toEqual([{ query: "Roe v Wade", maxResults: 1 }]);
    expect(result.status).toBe("completed");
    expect(result.validatedCount).toBe(2);
    expect(result.authorityValidationDocumentKey).toBe(COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY);
    expect(result.validationRecords.every((record) => record.legalConclusionVerified === false && record.promoted === false)).toBe(true);
    expect(result.safetyNotice).toContain("not good-law verification");
  });

  it("distinguishes not-found, ambiguous, and unavailable statuses", async () => {
    const notFound = await validateAuthorityCandidatesWithCourtListener({ client: new FakeCourtListenerClient({ results: [] }), request: { citations: ["1 U.S. 1"] } });
    expect(notFound.validationRecords[0].status).toBe("not-found");
    expect(notFound.unmatchedCount).toBe(1);

    const ambiguous = await validateAuthorityCandidatesWithCourtListener({ client: new FakeCourtListenerClient({ results: [{ citation: "1 U.S. 1" }, { citation: "1 U.S. 1" }] }), request: { citations: ["1 U.S. 1"] } });
    expect(ambiguous.validationRecords[0].status).toBe("ambiguous");
    expect(ambiguous.validatedCount).toBe(0);
    expect(ambiguous.unmatchedCount).toBe(1);
    expect(ambiguous.status).toBe("partial");

    const unavailable = await validateAuthorityCandidatesWithCourtListener({ client: new FakeCourtListenerClient({}, true), request: { citations: ["1 U.S. 1"] } });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.validationRecords[0].status).toBe("unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("super-secret-token");
  });

  it("returns explicit no-candidate status", async () => {
    const result = await validateAuthorityCandidatesWithCourtListener({ client: new FakeCourtListenerClient({}), request: { text: "No legal authority here." } });
    expect(result.status).toBe("no-candidates");
    expect(result.diagnostics[0].message).toContain("No bounded citation or authority candidates");
  });
});
