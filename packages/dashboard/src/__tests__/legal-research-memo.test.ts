import { describe, expect, it } from "vitest";
import type { Task, TaskDocument } from "@fusion/core";
import {
  COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
  COURTLISTENER_STATUS_DOCUMENT_KEY,
} from "../legal-courtlistener.js";
import {
  VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
  VAULT_MINING_STATUS_DOCUMENT_KEY,
} from "../legal-vault-mining.js";
import {
  RESEARCH_MEMO_DOCUMENT_KEY,
  RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
  buildResearchMemoMarkdown,
  collectCounterLawsuitResearchMemoInputs,
  deriveResearchMemoStatusForRun,
  generateCounterLawsuitResearchMemo,
  locateCounterLawsuitResearchMemoStageTask,
} from "../legal-research-memo.js";

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
      documentKey: stage === "research-memo" ? "research-memo" : "evidence-ledger",
    },
  } as Task;
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptId: "R-001",
    sourceSystem: "obsidian-mcp",
    providerName: "obsidian",
    toolName: "search",
    query: "fraud chronology",
    sourcePath: "Vault/Fraud/chronology.md",
    title: "Chronology",
    excerpt: "A bounded excerpt from the vault receipt.",
    retrievedAt: "2026-05-06T00:00:00.000Z",
    hash: "hash-1",
    verified: false,
    ...overrides,
  };
}

function authority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: "CL-001",
    input: "410 U.S. 113",
    inputType: "citation",
    status: "matched",
    normalizedCitation: "410 U.S. 113",
    caseName: "Roe v. Wade",
    courtListenerUrl: "https://www.courtlistener.com/opinion/108713/roe-v-wade/",
    retrievedAt: "2026-05-06T00:00:00.000Z",
    hash: "hash-cl-1",
    legalConclusionVerified: false,
    promoted: false,
    ...overrides,
  };
}

class FakeTaskStore {
  tasks: Task[] = [makeTask("FN-1", "research-memo"), makeTask("FN-2", "evidence-ledger")];
  documents = new Map<string, TaskDocument>();
  failNextMemoUpsert = false;

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }): Promise<TaskDocument> {
    if (this.failNextMemoUpsert && input.key === RESEARCH_MEMO_DOCUMENT_KEY) {
      this.failNextMemoUpsert = false;
      throw new Error("writer failed --qmd-token super-secret-token-value");
    }
    const doc = {
      id: `${taskId}:${input.key}`,
      taskId,
      key: input.key,
      content: input.content,
      revision: 1,
      author: input.author ?? "fusion",
      metadata: input.metadata,
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument;
    this.documents.set(`${taskId}:${input.key}`, doc);
    return doc;
  }

  setDocument(key: string, content: string, metadata?: Record<string, unknown>): void {
    this.documents.set(`FN-1:${key}`, {
      id: `FN-1:${key}`,
      taskId: "FN-1",
      key,
      content,
      revision: 1,
      author: "test",
      metadata,
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument);
  }
}

function seedPrerequisites(store: FakeTaskStore, options: { receipts?: Record<string, unknown>[]; authorities?: Record<string, unknown>[]; vaultMetadata?: boolean } = {}): void {
  const receipts = options.receipts ?? [receipt()];
  const authorities = options.authorities ?? [authority(), authority({ recordId: "CL-002", input: "Unknown authority", status: "not-found" })];
  store.setDocument(
    VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
    `# Vault receipts\n\n\`\`\`json\n${JSON.stringify({ queries: ["fallback query"], receipts })}\n\`\`\``,
    options.vaultMetadata === false ? undefined : { receipts, queries: ["metadata query"], providerDiagnostics: [] },
  );
  store.setDocument(VAULT_MINING_STATUS_DOCUMENT_KEY, "# status", { status: "completed", receiptCount: receipts.length });
  store.setDocument(
    COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
    `# Authority validation\n\n\`\`\`json\n${JSON.stringify({ validationRecords: authorities })}\n\`\`\``,
    { validationRecords: authorities, diagnostics: [] },
  );
  store.setDocument(COURTLISTENER_STATUS_DOCUMENT_KEY, "# status", { status: "partial" });
}

describe("research memo input collection", () => {
  it("locates the research-memo stage task by workflow metadata", async () => {
    const store = new FakeTaskStore();
    const located = await locateCounterLawsuitResearchMemoStageTask({ taskStore: store as never, runId: "CLW-1" });
    expect(located.researchMemoTask.id).toBe("FN-1");
    expect(located.tasks.map((task) => task.id)).toEqual(["FN-1", "FN-2"]);
  });

  it("prefers metadata over JSON blocks while preserving source paths and searches", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store, { receipts: [receipt({ receiptId: "R-META", sourcePath: "Vault/meta.md", query: "metadata query" })] });
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T01:00:00.000Z") });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ receiptId: "R-META", sourcePath: "Vault/meta.md", verified: false });
    expect(result.searches[0]).toMatchObject({ query: "metadata query", receiptIds: ["R-META"] });
    expect(result.status).toBe("partial");
  });

  it("ignores conflicting JSON content when metadata is present", async () => {
    const store = new FakeTaskStore();
    store.setDocument(
      VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
      `# Vault receipts\n\n\`\`\`json\n${JSON.stringify({ receipts: [receipt({ receiptId: "R-JSON", sourcePath: "Vault/json.md" })] })}\n\`\`\``,
      { receipts: [receipt({ receiptId: "R-META", sourcePath: "Vault/meta.md" })], queries: ["metadata query"] },
    );
    store.setDocument(COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY, "# Authority", { validationRecords: [authority()] });
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === VAULT_MINING_RECEIPTS_DOCUMENT_KEY)?.parsedFrom).toBe("metadata");
    expect(result.evidence.map((item) => item.receiptId)).toEqual(["R-META"]);
    expect(JSON.stringify(result)).not.toContain("R-JSON");
  });

  it("falls back to the machine-readable JSON block when metadata is absent", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store, { receipts: [receipt({ receiptId: "R-JSON", sourcePath: "Vault/json.md" })], vaultMetadata: false });
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === VAULT_MINING_RECEIPTS_DOCUMENT_KEY)?.parsedFrom).toBe("json-block");
    expect(result.evidence[0]).toMatchObject({ receiptId: "R-JSON", sourcePath: "Vault/json.md" });
  });

  it("turns malformed manifests and missing prerequisites into diagnostics", async () => {
    const store = new FakeTaskStore();
    store.setDocument(VAULT_MINING_RECEIPTS_DOCUMENT_KEY, "# no json", undefined);
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("malformed-manifest");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing-document");
  });

  it("preserves authority gaps and deterministic ordering", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store, {
      receipts: [receipt({ receiptId: "R-002" }), receipt({ receiptId: "R-001", sourcePath: "Vault/a.md" })],
      authorities: [authority({ recordId: "CL-002", status: "ambiguous" }), authority({ recordId: "CL-001" })],
    });
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.evidence.map((item) => item.receiptId)).toEqual(["R-001", "R-002"]);
    expect(result.authorities.map((item) => item.recordId)).toEqual(["CL-001", "CL-002"]);
    expect(result.conclusions.some((conclusion) => conclusion.unresolvedGap && conclusion.supportAuthorityRecordIds.includes("CL-002"))).toBe(true);
  });

  it("does not silently accept evidence missing source paths", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store, { receipts: [receipt({ sourcePath: undefined })] });
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.evidence).toHaveLength(0);
    expect(result.status).toBe("blocked");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-evidence-receipt")).toBe(true);
  });
});

describe("research memo generation", () => {
  it("writes a source-linked draft memo and safe metadata manifest", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store);
    const result = await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    const memo = await store.getTaskDocument("FN-1", RESEARCH_MEMO_DOCUMENT_KEY);
    expect(result.memoDocumentKey).toBe(RESEARCH_MEMO_DOCUMENT_KEY);
    expect(memo?.content).toContain("Draft-only legal research memo");
    expect(memo?.content).toContain("Vault/Fraud/chronology.md");
    expect(memo?.content).toContain("CL-001");
    expect(memo?.content).not.toMatch(/filing-ready legal advice/i);
    expect(memo?.metadata).toMatchObject({ runId: "CLW-1", evidence: expect.any(Array), authorities: expect.any(Array), safetyNotice: expect.any(String) });
  });

  it("overwrites stale blocker status after a completed retry", async () => {
    const store = new FakeTaskStore();
    await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1" });
    expect((await store.getTaskDocument("FN-1", RESEARCH_MEMO_STATUS_DOCUMENT_KEY))?.metadata?.status).toBe("blocked");
    seedPrerequisites(store);
    store.setDocument(COURTLISTENER_STATUS_DOCUMENT_KEY, "# status", { status: "completed" });
    const result = await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1", force: true });
    const status = await store.getTaskDocument("FN-1", RESEARCH_MEMO_STATUS_DOCUMENT_KEY);
    const summary = await deriveResearchMemoStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("completed");
    expect(status?.metadata?.status).toBe("completed");
    expect(summary.status).toBe("completed");
  });

  it("writes status documents for blocked and partial generation", async () => {
    const store = new FakeTaskStore();
    const result = await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1" });
    const statusDoc = await store.getTaskDocument("FN-1", RESEARCH_MEMO_STATUS_DOCUMENT_KEY);
    expect(result.status).toBe("blocked");
    expect(statusDoc?.metadata).toMatchObject({ status: "blocked", memoDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY });
  });

  it("writes a failed status document with redacted diagnostics when persistence fails", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store);
    store.failNextMemoUpsert = true;
    const result = await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1" });
    const statusDoc = await store.getTaskDocument("FN-1", RESEARCH_MEMO_STATUS_DOCUMENT_KEY);
    const serialized = `${statusDoc?.content}\n${JSON.stringify(statusDoc?.metadata)}`;
    expect(result.status).toBe("failed");
    expect(statusDoc?.metadata?.status).toBe("failed");
    expect(serialized).toContain("research-memo-generation-failed");
    expect(serialized).not.toContain("super-secret-token-value");
  });

  it("redacts secret-like values from memo content and metadata", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store, { receipts: [receipt({ excerpt: "token=super-secret-token-value authorization: bearer abcdefghijklmnop --obsidian-api-key standalone-secret-value" })] });
    await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1" });
    const memo = await store.getTaskDocument("FN-1", RESEARCH_MEMO_DOCUMENT_KEY);
    const serialized = `${memo?.content}\n${JSON.stringify(memo?.metadata)}`;
    expect(serialized).not.toContain("super-secret-token-value");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("standalone-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });

  it("derives status summaries from persisted memo documents", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store);
    await generateCounterLawsuitResearchMemo({ taskStore: store as never, runId: "CLW-1" });
    const summary = await deriveResearchMemoStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary).toMatchObject({ runId: "CLW-1", memoDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY, evidenceCount: 1, authorityCount: 2, sourcePathCount: 1 });
  });

  it("bounds generated text output", async () => {
    const store = new FakeTaskStore();
    seedPrerequisites(store, { receipts: [receipt({ excerpt: "x".repeat(5_000) })] });
    const result = await collectCounterLawsuitResearchMemoInputs({ taskStore: store as never, runId: "CLW-1" });
    const markdown = buildResearchMemoMarkdown(result);
    expect(result.evidence[0].excerpt?.length).toBeLessThanOrEqual(900);
    expect(markdown.length).toBeLessThan(12_000);
  });
});
