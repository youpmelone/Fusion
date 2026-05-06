import { describe, expect, it } from "vitest";
import type { Task, TaskDocument } from "@fusion/core";
import {
  RESEARCH_MEMO_DOCUMENT_KEY,
  RESEARCH_MEMO_STATUS_DOCUMENT_KEY,
} from "../legal-research-memo.js";
import {
  EVIDENCE_LEDGER_DOCUMENT_KEY,
  EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
  buildEvidenceLedgerMarkdown,
  collectCounterLawsuitEvidenceLedgerInputs,
  deriveEvidenceLedgerStatusForRun,
  generateCounterLawsuitEvidenceLedger,
  locateCounterLawsuitEvidenceLedgerStageTasks,
} from "../legal-evidence-ledger.js";

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

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptId: "R-001",
    sourcePath: "Vault/Fraud/chronology.md",
    sourceSystem: "obsidian-mcp",
    providerName: "obsidian",
    toolName: "search",
    query: "fraud chronology",
    title: "Chronology",
    excerpt: "The receipt says payment was diverted after notice.",
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
    status: "matched",
    normalizedCitation: "410 U.S. 113",
    courtListenerUrl: "https://www.courtlistener.com/opinion/108713/roe-v-wade/",
    legalConclusionVerified: false,
    promoted: false,
    ...overrides,
  };
}

function conclusion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusionId: "C-001",
    text: "Source-linked receipts suggest a candidate factual issue about diverted payments.",
    supportReceiptIds: ["R-001"],
    supportAuthorityRecordIds: ["CL-001"],
    unresolvedGap: false,
    ...overrides,
  };
}

class FakeTaskStore {
  tasks: Task[] = [makeTask("FN-1", "research-memo"), makeTask("FN-2", "evidence-ledger")];
  documents = new Map<string, TaskDocument>();
  failNextLedgerUpsert = false;

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }): Promise<TaskDocument> {
    if (this.failNextLedgerUpsert && input.key === EVIDENCE_LEDGER_DOCUMENT_KEY) {
      this.failNextLedgerUpsert = false;
      throw new Error("writer failed --auth-token super-secret-token-value");
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

  setResearchMemo(content: string, metadata?: Record<string, unknown>): void {
    this.documents.set(`FN-1:${RESEARCH_MEMO_DOCUMENT_KEY}`, {
      id: `FN-1:${RESEARCH_MEMO_DOCUMENT_KEY}`,
      taskId: "FN-1",
      key: RESEARCH_MEMO_DOCUMENT_KEY,
      content,
      revision: 1,
      author: "test",
      metadata,
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument);
  }

  setDocument(taskId: string, key: string, content: string, metadata?: Record<string, unknown>): void {
    this.documents.set(`${taskId}:${key}`, {
      id: `${taskId}:${key}`,
      taskId,
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

function seedMemo(store: FakeTaskStore, options: {
  evidence?: Record<string, unknown>[];
  authorities?: Record<string, unknown>[];
  conclusions?: Record<string, unknown>[];
  metadata?: boolean;
  status?: string;
} = {}): void {
  const evidenceItems = options.evidence ?? [evidence()];
  const authorities = options.authorities ?? [authority(), authority({ recordId: "CL-002", input: "Unknown authority", status: "not-found" })];
  const conclusions = options.conclusions ?? [conclusion(), conclusion({ conclusionId: "C-002", text: "Unmatched authority remains a research gap.", supportReceiptIds: ["R-001"], supportAuthorityRecordIds: ["CL-002"], unresolvedGap: true })];
  const manifest = {
    runId: "CLW-1",
    generatedAt: "2026-05-06T01:00:00.000Z",
    status: options.status ?? "completed",
    sourceDocuments: [],
    evidence: evidenceItems,
    authorities,
    conclusions,
    diagnostics: [],
    safetyNotice: "Draft-only legal research memo generated from persisted source manifests. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.",
  };
  store.setResearchMemo(`# memo\n\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``, options.metadata === false ? undefined : manifest);
}

describe("evidence ledger input collection", () => {
  it("locates research-memo and evidence-ledger tasks by workflow metadata", async () => {
    const store = new FakeTaskStore();
    const located = await locateCounterLawsuitEvidenceLedgerStageTasks({ taskStore: store as never, runId: "CLW-1" });
    expect(located.researchMemoTask.id).toBe("FN-1");
    expect(located.evidenceLedgerTask.id).toBe("FN-2");
    expect(located.tasks.map((task) => task.id)).toEqual(["FN-1", "FN-2"]);
  });

  it("prefers research memo metadata over JSON block content", async () => {
    const store = new FakeTaskStore();
    const metadataManifest = { runId: "CLW-1", status: "completed", evidence: [evidence({ receiptId: "R-META", sourcePath: "Vault/meta.md" })], authorities: [authority()], conclusions: [conclusion({ supportReceiptIds: ["R-META"] })], diagnostics: [] };
    const jsonManifest = { runId: "CLW-1", status: "completed", evidence: [evidence({ receiptId: "R-JSON", sourcePath: "Vault/json.md" })], authorities: [authority()], conclusions: [conclusion({ supportReceiptIds: ["R-JSON"] })], diagnostics: [] };
    store.setResearchMemo(`# memo\n\n\`\`\`json\n${JSON.stringify(jsonManifest)}\n\`\`\``, metadataManifest);
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === RESEARCH_MEMO_DOCUMENT_KEY)?.parsedFrom).toBe("metadata");
    expect(result.sourceLinks[0]).toMatchObject({ receiptId: "R-META", sourcePath: "Vault/meta.md" });
    expect(JSON.stringify(result)).not.toContain("R-JSON");
  });

  it("falls back to the machine-readable JSON block when metadata is absent", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { evidence: [evidence({ receiptId: "R-JSON", sourcePath: "Vault/json.md" })], conclusions: [conclusion({ supportReceiptIds: ["R-JSON"] })], metadata: false });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === RESEARCH_MEMO_DOCUMENT_KEY)?.parsedFrom).toBe("json-block");
    expect(result.facts[0].sourceLinks[0]).toMatchObject({ receiptId: "R-JSON", sourcePath: "Vault/json.md" });
  });

  it("turns malformed or missing research memo manifests into blocked diagnostics", async () => {
    const malformed = new FakeTaskStore();
    malformed.setResearchMemo("# no manifest", undefined);
    const malformedResult = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: malformed as never, runId: "CLW-1" });
    expect(malformedResult.status).toBe("blocked");
    expect(malformedResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("malformed-manifest");

    const missing = new FakeTaskStore();
    const missingResult = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: missing as never, runId: "CLW-1" });
    expect(missingResult.status).toBe("blocked");
    expect(missingResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing-document");
  });

  it("keeps stale or blocked research-memo-status from becoming completed support", async () => {
    const store = new FakeTaskStore();
    seedMemo(store);
    store.setDocument("FN-1", RESEARCH_MEMO_STATUS_DOCUMENT_KEY, "# status", { status: "blocked", diagnostics: [{ code: "memo-blocked", severity: "error", message: "blocked" }] });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.statusDocumentKey).toBe(EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "research-memo-status-blocker")).toBe(true);
  });

  it("preserves deterministic ordering and bounded redacted text output", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, {
      evidence: [evidence({ receiptId: "R-002", sourcePath: "Vault/b.md" }), evidence({ receiptId: "R-001", sourcePath: "Vault/a.md", excerpt: `secret token=abc123456789 ${"x".repeat(1000)}` })],
      authorities: [authority({ recordId: "CL-002", status: "ambiguous" }), authority({ recordId: "CL-001" })],
      conclusions: [conclusion({ conclusionId: "C-002", supportReceiptIds: ["R-002"], supportAuthorityRecordIds: ["CL-002"] }), conclusion({ conclusionId: "C-001", supportReceiptIds: ["R-001"], supportAuthorityRecordIds: ["CL-001"] })],
    });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.facts.map((fact) => fact.factId)).toEqual(["F-001", "F-002"]);
    expect(result.sourceLinks.map((link) => link.receiptId)).toEqual(["R-001", "R-002"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("abc123456789");
    expect(serialized.length).toBeLessThan(25000);
  });
});

describe("evidence ledger fact derivation", () => {
  it("maps facts to source receipts, source paths, preliminary claim links, confidence, and citation status", async () => {
    const store = new FakeTaskStore();
    seedMemo(store);
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.facts[0]).toMatchObject({ verified: false, confidence: "high", authorityRecordIds: ["CL-001"] });
    expect(result.facts[0].sourceLinks[0]).toMatchObject({ receiptId: "R-001", sourcePath: "Vault/Fraud/chronology.md" });
    expect(result.facts[0].claimLinks[0]).toMatchObject({ conclusionId: "C-001", createsClaimMap: false });
    expect(result.facts[0].citationStatus.map((status) => status.status)).toEqual(expect.arrayContaining(["source-linked-local-evidence", "matched-courtlistener-lookup-record", "needs-human-citation-verification"]));
  });

  it("uses conservative confidence for unresolved authorities and unsupported gaps", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { authorities: [authority({ recordId: "CL-002", status: "not-found" })], conclusions: [conclusion({ supportAuthorityRecordIds: ["CL-002"] }), conclusion({ conclusionId: "C-002", text: "No source support yet.", supportReceiptIds: [], supportAuthorityRecordIds: [], unresolvedGap: true })] });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.facts[0].confidence).toBe("medium");
    expect(result.facts[0].citationStatus.some((status) => status.status === "unresolved-authority-lookup-record" && status.unresolved)).toBe(true);
    expect(result.facts[1].confidence).toBe("unsupported");
    expect(result.facts[1].citationStatus.some((status) => status.status === "missing-source-link")).toBe(true);
  });

  it("does not silently accept invalid source links from research memo evidence", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { evidence: [evidence({ sourcePath: undefined })] });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceLinks).toHaveLength(0);
    expect(result.facts[0].confidence).toBe("unsupported");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-ledger-source-link")).toBe(true);
  });

  it("keeps evidence without a linked conclusion as a non-high unresolved placeholder", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { evidence: [evidence({ receiptId: "R-ORPHAN" })], conclusions: [] });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    const orphan = result.facts.find((fact) => fact.sourceLinks.some((link) => link.receiptId === "R-ORPHAN"));
    expect(orphan).toMatchObject({ unresolvedGap: true, confidence: "low" });
    expect(orphan?.claimLinks[0]).toMatchObject({ status: "unresolved-placeholder", createsClaimMap: false });
    expect(orphan?.diagnostics.some((diagnostic) => diagnostic.code === "unlinked-evidence-placeholder")).toBe(true);
  });

  it("keeps unreferenced unresolved authority records visible in citation status output", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { authorities: [authority({ recordId: "CL-ORPHAN", status: "unavailable" })], conclusions: [] });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    const authorityStatus = result.citationStatuses.find((status) => status.authorityRecordId === "CL-ORPHAN");
    expect(authorityStatus).toMatchObject({ status: "unresolved-authority-lookup-record", unresolved: true, support: false });
    expect(result.facts.find((fact) => fact.authorityRecordIds.includes("CL-ORPHAN"))).toMatchObject({ confidence: "unsupported", unresolvedGap: true });
  });
});

describe("evidence ledger generation", () => {
  it("writes a Markdown ledger and safe metadata manifest", async () => {
    const store = new FakeTaskStore();
    seedMemo(store);
    const result = await generateCounterLawsuitEvidenceLedger({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    const ledger = await store.getTaskDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY);
    expect(result.ledgerDocumentKey).toBe(EVIDENCE_LEDGER_DOCUMENT_KEY);
    expect(ledger?.content).toContain("## Fact table");
    expect(ledger?.content).toContain("## Source-link appendix");
    expect(ledger?.content).toContain("## Preliminary claim-link appendix");
    expect(ledger?.content).toContain("## Citation-status appendix");
    expect(ledger?.content).toContain("not legal advice");
    expect(ledger?.content).toContain("not filing-ready");
    expect(ledger?.metadata).toMatchObject({ runId: "CLW-1", status: "partial", evidenceLedgerTaskId: "FN-2" });
    expect(JSON.stringify(ledger?.metadata)).toContain("source-linked-local-evidence");
  });

  it("writes status documents for blocked and failed states without treating missing memo as completed", async () => {
    const blocked = new FakeTaskStore();
    const blockedResult = await generateCounterLawsuitEvidenceLedger({ taskStore: blocked as never, runId: "CLW-1" });
    expect(blockedResult.status).toBe("blocked");
    expect((await blocked.getTaskDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY))?.metadata).toMatchObject({ status: "blocked" });
    expect(await blocked.getTaskDocument("FN-2", EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY)).toBeTruthy();

    const failed = new FakeTaskStore();
    seedMemo(failed, { conclusions: [conclusion({ supportAuthorityRecordIds: [] })] });
    failed.failNextLedgerUpsert = true;
    const failedResult = await generateCounterLawsuitEvidenceLedger({ taskStore: failed as never, runId: "CLW-1" });
    expect(failedResult.status).toBe("failed");
    const status = await failed.getTaskDocument("FN-2", EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY);
    expect(status?.content).not.toContain("super-secret-token-value");
    expect(JSON.stringify(status?.metadata)).not.toContain("super-secret-token-value");
  });

  it("derives status from persisted ledger or status documents", async () => {
    const store = new FakeTaskStore();
    seedMemo(store);
    await generateCounterLawsuitEvidenceLedger({ taskStore: store as never, runId: "CLW-1" });
    const summary = await deriveEvidenceLedgerStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary).toMatchObject({ runId: "CLW-1", status: "partial", ledgerDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY, factCount: 2 });
    expect(summary.citationStatusCounts["unresolved-authority-lookup-record"]).toBe(1);
  });

  it("overwrites stale primary ledger output when research-memo-status later blocks regeneration", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { authorities: [authority()], conclusions: [conclusion({ supportAuthorityRecordIds: [] })] });
    await generateCounterLawsuitEvidenceLedger({ taskStore: store as never, runId: "CLW-1" });
    expect((await store.getTaskDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY))?.metadata).toMatchObject({ status: "completed" });

    store.setDocument("FN-1", RESEARCH_MEMO_STATUS_DOCUMENT_KEY, "# status", { status: "blocked", diagnostics: [{ code: "blocked", severity: "error", message: "memo blocked" }] });
    await generateCounterLawsuitEvidenceLedger({ taskStore: store as never, runId: "CLW-1" });
    const staleReplacement = await store.getTaskDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY);
    expect(staleReplacement?.metadata).toMatchObject({ status: "blocked" });
    expect(staleReplacement?.content).toContain("Status: blocked");
    expect(staleReplacement?.content).toContain("research-memo-status reports blocked");
  });

  it("builds bounded Markdown without raw secret-like strings", async () => {
    const store = new FakeTaskStore();
    seedMemo(store, { conclusions: [conclusion({ text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" })] });
    const result = await collectCounterLawsuitEvidenceLedgerInputs({ taskStore: store as never, runId: "CLW-1" });
    const markdown = buildEvidenceLedgerMarkdown(result);
    expect(markdown).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown.length).toBeLessThan(30000);
  });

  it("handles malformed persisted diagnostic severity without throwing", async () => {
    const store = new FakeTaskStore();
    const manifest = { runId: "CLW-1", status: "completed", evidence: [evidence()], authorities: [authority()], conclusions: [conclusion()], diagnostics: [{ code: "bad-diagnostic", message: "missing severity" }] };
    store.setResearchMemo("# memo", manifest as Record<string, unknown>);
    const result = await generateCounterLawsuitEvidenceLedger({ taskStore: store as never, runId: "CLW-1" });
    const ledger = await store.getTaskDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY);
    expect(result.diagnostics.find((diagnostic) => diagnostic.code === "bad-diagnostic")?.severity).toBe("warning");
    expect(ledger?.content).toContain("WARNING bad-diagnostic");
  });
});
