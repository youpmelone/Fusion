import { describe, expect, it, vi } from "vitest";
import type { ResearchRun, Task, TaskDocument } from "@fusion/core";
import {
  COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
  COURTLISTENER_STATUS_DOCUMENT_KEY,
  COURTLISTENER_RESEARCH_TRIGGER,
  createCourtListenerClient,
  deriveAuthorityValidationStatusForRun,
  extractCourtListenerAuthorityCandidates,
  normalizeCourtListenerAuthorityRecord,
  validateAuthorityCandidatesWithCourtListener,
  validateCounterLawsuitAuthorities,
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

function makeTask(id: string, stage: string, runId = "CLW-1"): Task {
  return {
    id,
    title: stage,
    description: stage,
    priority: "high",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
    sourceMetadata: {
      workflowKind: "counter-lawsuit-prototype",
      workflowRunId: runId,
      workflowStage: stage,
      workflowStageIndex: stage === "research-memo" ? 0 : 1,
    },
  };
}

class FakeResearchStore {
  runs: ResearchRun[] = [];
  createRun(input: any): ResearchRun {
    const run = {
      id: `RR-${this.runs.length + 1}`,
      query: input.query,
      topic: input.topic,
      status: "queued",
      trigger: input.trigger,
      sources: input.sources ?? [],
      events: [],
      tags: input.tags ?? [],
      metadata: input.metadata,
      lifecycle: input.lifecycle,
      createdAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
    } as ResearchRun;
    this.runs.push(run);
    return run;
  }
  updateStatus(id: string, status: ResearchRun["status"], extra?: Partial<ResearchRun>): void {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error("missing run");
    Object.assign(run, extra ?? {}, { status });
  }
}

class FakeTaskStore {
  tasks = [makeTask("FN-1", "research-memo"), makeTask("FN-2", "evidence-ledger")];
  documents = new Map<string, TaskDocument>();
  researchStore = new FakeResearchStore();

  constructor() {
    this.documents.set("FN-1:counter-lawsuit-stage", {
      id: "DOC-STAGE",
      taskId: "FN-1",
      key: "counter-lawsuit-stage",
      content: "# Stage\n",
      revision: 1,
      author: "fusion",
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument);
  }

  async listTasks(): Promise<Task[]> { return this.tasks; }
  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }): Promise<TaskDocument> {
    const doc = { id: `${taskId}:${input.key}`, taskId, key: input.key, content: input.content, revision: 1, author: input.author ?? "fusion", metadata: input.metadata, createdAt: "now", updatedAt: "now" } as TaskDocument;
    this.documents.set(`${taskId}:${input.key}`, doc);
    return doc;
  }
  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }
  getResearchStore(): FakeResearchStore { return this.researchStore; }
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

  it("redacts standalone flags and authorization key/value forms in raw summaries", () => {
    const record = normalizeCourtListenerAuthorityRecord({
      input: "1 U.S. 1",
      inputType: "citation",
      status: "unavailable",
      rawResult: {
        error: "courtlistener --auth-token super-secret-value failed authorization=plain-secret-value Authorization: Token header-secret-value",
      },
    });
    expect(record.rawResultSummary).not.toContain("super-secret-value");
    expect(record.rawResultSummary).not.toContain("plain-secret-value");
    expect(record.rawResultSummary).not.toContain("header-secret-value");
  });

  it("handles CourtListener citation-keyed lookup response objects", async () => {
    const keyed = await validateAuthorityCandidatesWithCourtListener({
      client: new FakeCourtListenerClient({
        "410 U.S. 113": [{ case_name: "Roe v. Wade", absolute_url: "/opinion/108713/roe-v-wade/" }],
      }),
      request: { citations: ["410 U.S. 113"] },
    });
    expect(keyed.validationRecords[0]).toMatchObject({ status: "matched", caseName: "Roe v. Wade" });
    expect(keyed.validatedCount).toBe(1);
  });

  it("does not promote citation-keyed wrapper responses with empty or multiple clusters", async () => {
    const empty = await validateAuthorityCandidatesWithCourtListener({
      client: new FakeCourtListenerClient({ "1 U.S. 1": [{ citation: "1 U.S. 1", clusters: [] }] }),
      request: { citations: ["1 U.S. 1"] },
    });
    expect(empty.validationRecords[0].status).toBe("not-found");
    expect(empty.validatedCount).toBe(0);

    const single = await validateAuthorityCandidatesWithCourtListener({
      client: new FakeCourtListenerClient({ "1 U.S. 1": [{ citation: "1 U.S. 1", clusters: [{ case_name: "Single", absolute_url: "/opinion/1/single/" }] }] }),
      request: { citations: ["1 U.S. 1"] },
    });
    expect(single.validationRecords[0]).toMatchObject({ status: "matched", caseName: "Single" });
    expect(single.validatedCount).toBe(1);

    const multiple = await validateAuthorityCandidatesWithCourtListener({
      client: new FakeCourtListenerClient({ "1 U.S. 1": [{ citation: "1 U.S. 1", clusters: [{ case_name: "Left" }, { case_name: "Right" }] }] }),
      request: { citations: ["1 U.S. 1"] },
    });
    expect(multiple.validationRecords[0].status).toBe("ambiguous");
    expect(multiple.validatedCount).toBe(0);
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
    const client = new FakeCourtListenerClient({ results: [{ citation: "410 U.S. 113", case_name: "Roe v. Wade", absolute_url: "/opinion/108713/roe-v-wade/" }] });
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

  it("redacts and bounds provider diagnostics for unavailable CourtListener", async () => {
    const longSecret = `provider failed authorization=plain-secret-value ${"x".repeat(2_000)}`;
    const client: CourtListenerClient = {
      async lookupCitation() { throw new Error(longSecret); },
      async searchAuthorities() { throw new Error(longSecret); },
    };
    const result = await validateAuthorityCandidatesWithCourtListener({ client, request: { citations: ["1 U.S. 1"] } });
    expect(result.diagnostics[0].message.length).toBeLessThanOrEqual(700);
    expect(result.diagnostics[0].message).not.toContain("plain-secret-value");
    expect(JSON.stringify(result)).not.toContain("plain-secret-value");
  });

  it("returns explicit no-candidate status", async () => {
    const result = await validateAuthorityCandidatesWithCourtListener({ client: new FakeCourtListenerClient({}), request: { text: "No legal authority here." } });
    expect(result.status).toBe("no-candidates");
    expect(result.diagnostics[0].message).toContain("No bounded citation or authority candidates");
  });
});

describe("counter-lawsuit CourtListener persistence", () => {
  it("persists matched authorities to ResearchStore and task documents", async () => {
    const store = new FakeTaskStore();
    store.documents.set("FN-1:vault-mining-receipts", {
      id: "DOC-VAULT",
      taskId: "FN-1",
      key: "vault-mining-receipts",
      content: "# receipts",
      metadata: { receipts: [{ receiptId: "LVR-1", query: "Roe v Wade", excerpt: "Source cites 410 U.S. 113." }] },
      revision: 1,
      author: "fusion",
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument);

    const result = await validateCounterLawsuitAuthorities({
      taskStore: store as any,
      runId: "CLW-1",
      client: new FakeCourtListenerClient({ "410 U.S. 113": [{ case_name: "Roe v. Wade", citation: "410 U.S. 113", absolute_url: "/opinion/108713/roe-v-wade/" }] }),
      now: () => new Date("2026-05-06T00:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.researchRunId).toBe("RR-1");
    expect(store.researchStore.runs[0].trigger).toBe(COURTLISTENER_RESEARCH_TRIGGER);
    expect(store.researchStore.runs[0].sources).toHaveLength(2);
    expect(store.researchStore.runs[0].sources[0]).toMatchObject({ type: "web", reference: "https://www.courtlistener.com/opinion/108713/roe-v-wade/" });
    expect(store.researchStore.runs[0].sources[0].metadata?.courtListenerAuthorityValidation).toMatchObject({ legalConclusionVerified: false, promoted: false });

    const manifest = await store.getTaskDocument("FN-1", COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY);
    expect(manifest?.content).toContain("CourtListener authority validation");
    expect(manifest?.content).toContain("not good-law verification");
    expect(manifest?.content).toContain("legalConclusionVerified: false");
    expect(JSON.stringify(manifest?.metadata)).not.toContain("super-secret-token");

    const status = await store.getTaskDocument("FN-1", COURTLISTENER_STATUS_DOCUMENT_KEY);
    expect(status?.content).toContain("Retry needed: no");

    const derived = await deriveAuthorityValidationStatusForRun({ taskStore: store as any, runId: "CLW-1" });
    expect(derived).toMatchObject({ status: "completed", candidateCount: 2, validatedCount: 2, unmatchedCount: 0, researchRunId: "RR-1" });
  });

  it("writes explicit no-candidate status without treating it as success", async () => {
    const store = new FakeTaskStore();
    const result = await validateCounterLawsuitAuthorities({
      taskStore: store as any,
      runId: "CLW-1",
      client: new FakeCourtListenerClient({ results: [] }),
    });

    expect(result.status).toBe("no-candidates");
    expect(result.validatedCount).toBe(0);
    expect(store.researchStore.runs[0].sources).toHaveLength(0);
    const status = await store.getTaskDocument("FN-1", COURTLISTENER_STATUS_DOCUMENT_KEY);
    expect(status?.content).toContain("Retry needed: yes");
    expect(status?.content).toContain("No bounded citation or authority candidates");
  });

  it("does not persist citation-only echoes as matched web sources", async () => {
    const store = new FakeTaskStore();
    const result = await validateCounterLawsuitAuthorities({
      taskStore: store as any,
      runId: "CLW-1",
      request: { citations: ["1 U.S. 1"] },
      client: new FakeCourtListenerClient({ results: [{ citation: "1 U.S. 1" }] }),
    });

    expect(result.status).toBe("partial");
    expect(result.validatedCount).toBe(0);
    expect(result.validationRecords[0].status).toBe("not-found");
    expect(store.researchStore.runs[0].sources).toHaveLength(0);
    expect(JSON.stringify(store.researchStore.runs[0])).not.toContain("courtlistener:1 U.S. 1");
  });

  it("persists unavailable diagnostics redacted and does not mark legal conclusions verified", async () => {
    const store = new FakeTaskStore();
    const result = await validateCounterLawsuitAuthorities({
      taskStore: store as any,
      runId: "CLW-1",
      request: { citations: ["1 U.S. 1"] },
      client: new FakeCourtListenerClient({}, true),
    });

    expect(result.status).toBe("unavailable");
    expect(result.validationRecords[0]).toMatchObject({ status: "unavailable", legalConclusionVerified: false, promoted: false });
    const manifest = await store.getTaskDocument("FN-1", COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY);
    expect(JSON.stringify(manifest)).not.toContain("super-secret-token");
    expect(manifest?.content).toContain("not attorney judgment");
  });
});
