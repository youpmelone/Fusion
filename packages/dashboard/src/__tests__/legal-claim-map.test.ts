import { describe, expect, it } from "vitest";
import type { Task, TaskDocument } from "@fusion/core";
import {
  EVIDENCE_LEDGER_DOCUMENT_KEY,
  EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY,
} from "../legal-evidence-ledger.js";
import { RESEARCH_MEMO_DOCUMENT_KEY } from "../legal-research-memo.js";
import {
  CLAIM_MAP_DOCUMENT_KEY,
  CLAIM_MAP_STATUS_DOCUMENT_KEY,
  buildClaimMapMarkdown,
  collectCounterLawsuitClaimMapInputs,
  deriveClaimMapStatusForRun,
  generateCounterLawsuitClaimMap,
  locateCounterLawsuitClaimMapStageTasks,
} from "../legal-claim-map.js";

function makeTask(id: string, stage: string, runId = "CLW-1"): Task {
  const stageIndex = stage === "research-memo" ? 0 : stage === "evidence-ledger" ? 1 : 2;
  const documentKey = stage === "research-memo" ? RESEARCH_MEMO_DOCUMENT_KEY : stage === "evidence-ledger" ? EVIDENCE_LEDGER_DOCUMENT_KEY : CLAIM_MAP_DOCUMENT_KEY;
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
      workflowStageIndex: stageIndex,
      documentKey,
    },
  } as Task;
}

function sourceLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceLinkId: "F-001-SRC-001",
    receiptId: "R-001",
    sourcePath: "Vault/Fraud/chronology.md",
    sourceSystem: "obsidian-mcp",
    providerName: "obsidian",
    toolName: "search",
    query: "fraud chronology",
    title: "Chronology",
    retrievedAt: "2026-05-06T00:00:00.000Z",
    hash: "hash-1",
    ...overrides,
  };
}

function citationStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    citationStatusId: "F-001-CIT-AUTH-CL-001",
    factId: "F-001",
    status: "matched-courtlistener-lookup-record",
    authorityRecordId: "CL-001",
    message: "Authority record CL-001 has a matched CourtListener lookup URL, but this is not good-law or citation-format validation.",
    unresolved: false,
    support: false,
    ...overrides,
  };
}

function fact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    factId: "F-001",
    factText: "Source-linked receipts suggest a candidate factual issue about diverted payments.",
    sourceLinks: [sourceLink()],
    claimLinks: [{ claimLinkId: "F-001-CLM-001", conclusionId: "C-001", factId: "F-001", label: "Research memo conclusion C-001", status: "upstream-research-memo-conclusion", createsClaimMap: false }],
    authorityRecordIds: ["CL-001"],
    confidence: "high",
    citationStatus: [citationStatus(), citationStatus({ citationStatusId: "F-001-CIT-HUMAN", authorityRecordId: undefined, status: "needs-human-citation-verification", message: "Human citation and source verification is still required before any use outside this draft workflow." })],
    unresolvedGap: false,
    diagnostics: [],
    verified: false,
    ...overrides,
  };
}

class FakeTaskStore {
  tasks: Task[] = [makeTask("FN-1", "research-memo"), makeTask("FN-2", "evidence-ledger"), makeTask("FN-3", "claim-map")];
  documents = new Map<string, TaskDocument>();
  failNextClaimMapUpsert = false;

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }): Promise<TaskDocument> {
    if (this.failNextClaimMapUpsert && input.key === CLAIM_MAP_DOCUMENT_KEY) {
      this.failNextClaimMapUpsert = false;
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

function seedLedger(store: FakeTaskStore, options: {
  facts?: Record<string, unknown>[];
  metadata?: boolean;
  ledgerStatus?: string;
  researchMemoMetadata?: boolean;
} = {}): Record<string, unknown> {
  const facts = options.facts ?? [fact(), fact({
    factId: "F-002",
    factText: "Unmatched authority remains a research gap.",
    sourceLinks: [sourceLink({ sourceLinkId: "F-002-SRC-001", receiptId: "R-002", sourcePath: "Vault/Gaps/authority.md" })],
    claimLinks: [{ claimLinkId: "F-002-CLM-001", conclusionId: "C-002", factId: "F-002", label: "Research memo conclusion C-002", status: "unresolved-placeholder", createsClaimMap: false }],
    authorityRecordIds: ["CL-002"],
    confidence: "medium",
    citationStatus: [citationStatus({ citationStatusId: "F-002-CIT-AUTH-CL-002", factId: "F-002", authorityRecordId: "CL-002", status: "unresolved-authority-lookup-record", unresolved: true, message: "Authority record CL-002 is missing, unmatched, ambiguous, unavailable, or lacks a CourtListener URL and remains unresolved." })],
    unresolvedGap: true,
  })];
  const manifest = {
    runId: "CLW-1",
    generatedAt: "2026-05-06T01:00:00.000Z",
    status: options.ledgerStatus ?? "completed",
    sourceDocuments: [],
    researchMemoTaskId: "FN-1",
    evidenceLedgerTaskId: "FN-2",
    facts,
    sourceLinks: facts.flatMap((item) => Array.isArray(item.sourceLinks) ? item.sourceLinks : []),
    claimLinks: facts.flatMap((item) => Array.isArray(item.claimLinks) ? item.claimLinks : []),
    citationStatuses: facts.flatMap((item) => Array.isArray(item.citationStatus) ? item.citationStatus : []),
    confidenceRubric: {},
    diagnostics: [],
    counts: { facts: facts.length, sourceLinks: 2, claimLinks: facts.length, unresolvedGaps: 1 },
    safetyNotice: "Draft-only structured evidence ledger generated from the persisted research memo manifest. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.",
  };
  store.setDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY, `# ledger\n\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``, options.metadata === false ? undefined : manifest);
  const memoManifest = {
    runId: "CLW-1",
    status: "completed",
    conclusions: [
      { conclusionId: "C-001", text: "Candidate claim group for diverted payments.", supportReceiptIds: ["R-001"], supportAuthorityRecordIds: ["CL-001"], unresolvedGap: false },
      { conclusionId: "C-002", text: "Candidate claim group with unresolved authority.", supportReceiptIds: ["R-002"], supportAuthorityRecordIds: ["CL-002"], unresolvedGap: true },
    ],
  };
  store.setDocument("FN-1", RESEARCH_MEMO_DOCUMENT_KEY, `# memo\n\n\`\`\`json\n${JSON.stringify(memoManifest)}\n\`\`\``, options.researchMemoMetadata === false ? undefined : memoManifest);
  return manifest;
}

describe("claim map input collection", () => {
  it("locates research-memo, evidence-ledger, and claim-map tasks by workflow metadata", async () => {
    const store = new FakeTaskStore();
    const located = await locateCounterLawsuitClaimMapStageTasks({ taskStore: store as never, runId: "CLW-1" });
    expect(located.researchMemoTask?.id).toBe("FN-1");
    expect(located.evidenceLedgerTask.id).toBe("FN-2");
    expect(located.claimMapTask.id).toBe("FN-3");
    expect(located.tasks.map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });

  it("prefers evidence ledger metadata over JSON block content", async () => {
    const store = new FakeTaskStore();
    const metadataManifest = seedLedger(store, { facts: [fact({ factId: "F-META", sourceLinks: [sourceLink({ sourceLinkId: "F-META-SRC-001", receiptId: "R-META", sourcePath: "Vault/meta.md" })] })] });
    const jsonManifest = { ...metadataManifest, facts: [fact({ factId: "F-JSON", sourceLinks: [sourceLink({ sourceLinkId: "F-JSON-SRC-001", receiptId: "R-JSON", sourcePath: "Vault/json.md" })] })] };
    store.setDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY, `# ledger\n\n\`\`\`json\n${JSON.stringify(jsonManifest)}\n\`\`\``, metadataManifest);
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === EVIDENCE_LEDGER_DOCUMENT_KEY)?.parsedFrom).toBe("metadata");
    expect(result.allegations[0].factId).toBe("F-META");
    expect(JSON.stringify(result)).not.toContain("R-JSON");
  });

  it("falls back to the machine-readable JSON block when metadata is absent", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ factId: "F-JSON", sourceLinks: [sourceLink({ sourceLinkId: "F-JSON-SRC-001", receiptId: "R-JSON", sourcePath: "Vault/json.md" })] })], metadata: false });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === EVIDENCE_LEDGER_DOCUMENT_KEY)?.parsedFrom).toBe("json-block");
    expect(result.supportingEvidence[0]).toMatchObject({ receiptId: "R-JSON", sourcePath: "Vault/json.md" });
  });

  it("turns malformed or missing evidence ledger manifests into blocked diagnostics", async () => {
    const malformed = new FakeTaskStore();
    malformed.setDocument("FN-2", EVIDENCE_LEDGER_DOCUMENT_KEY, "# no manifest", undefined);
    const malformedResult = await collectCounterLawsuitClaimMapInputs({ taskStore: malformed as never, runId: "CLW-1" });
    expect(malformedResult.status).toBe("blocked");
    expect(malformedResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("malformed-manifest");

    const missing = new FakeTaskStore();
    const missingResult = await collectCounterLawsuitClaimMapInputs({ taskStore: missing as never, runId: "CLW-1" });
    expect(missingResult.status).toBe("blocked");
    expect(missingResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing-document");
  });

  it("keeps stale or blocked evidence-ledger-status from becoming completed support", async () => {
    const store = new FakeTaskStore();
    seedLedger(store);
    store.setDocument("FN-2", EVIDENCE_LEDGER_STATUS_DOCUMENT_KEY, "# status", { status: "blocked", diagnostics: [{ code: "ledger-blocked", severity: "error", message: "blocked" }] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.statusDocumentKey).toBe(CLAIM_MAP_STATUS_DOCUMENT_KEY);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "evidence-ledger-status-blocker")).toBe(true);
    expect(result.missingProof.some((proof) => proof.scope === "workflow")).toBe(true);
  });

  it("preserves deterministic ordering and bounded redacted text output", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, {
      facts: [
        fact({ factId: "F-002", factText: "second", sourceLinks: [sourceLink({ sourceLinkId: "F-002-SRC-001", receiptId: "R-002", sourcePath: "Vault/b.md" })], claimLinks: [{ claimLinkId: "F-002-CLM-001", conclusionId: "C-002", factId: "F-002", label: "C2", status: "upstream-research-memo-conclusion", createsClaimMap: false }] }),
        fact({ factId: "F-001", factText: `token=abc123456789 ${"x".repeat(1000)}`, sourceLinks: [sourceLink({ sourceLinkId: "F-001-SRC-001", receiptId: "R-001", sourcePath: "Vault/a.md" })] }),
      ],
    });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.claims.map((claim) => claim.claimId)).toEqual(["CM-001", "CM-002"]);
    expect(result.supportingEvidence.map((support) => support.receiptId)).toEqual(["R-001", "R-002"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("abc123456789");
    expect(serialized.length).toBeLessThan(40000);
  });
});

describe("claim map derivation", () => {
  it("groups facts by upstream conclusion IDs and preserves ledger support", async () => {
    const store = new FakeTaskStore();
    seedLedger(store);
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.claims[0]).toMatchObject({ claimId: "CM-001", conclusionId: "C-001", verified: false });
    expect(result.allegations[0]).toMatchObject({ factId: "F-001", receiptIds: ["R-001"], sourcePaths: ["Vault/Fraud/chronology.md"], authorityRecordIds: ["CL-001"], upstreamConfidence: "high", verified: false });
    expect(result.supportingEvidence[0]).toMatchObject({ supportingEvidenceId: "SE-001", receiptId: "R-001", sourcePath: "Vault/Fraud/chronology.md", verified: false });
  });

  it("does not invent legal elements when upstream element fields are absent", async () => {
    const store = new FakeTaskStore();
    seedLedger(store);
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.elements[0]).toMatchObject({ label: "Legal element pending authority-backed extraction", invented: false, status: "missing-proof" });
    expect(result.missingProof.some((proof) => proof.reason.includes("no legal element was invented"))).toBe(true);
  });

  it("uses explicit safe upstream element fields when present", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ claimLinks: [{ claimLinkId: "F-001-CLM-001", conclusionId: "C-001", factId: "F-001", label: "C1", status: "upstream-research-memo-conclusion", createsClaimMap: false, elements: [{ label: "Misrepresentation pending attorney review" }] }] })] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.elements[0].label).toBe("Misrepresentation pending attorney review");
    expect(result.elements[0].invented).toBe(false);
  });

  it("does not cross-assign facts to explicit elements from other fact links", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [
      fact({ claimLinks: [{ claimLinkId: "F-001-CLM-001", conclusionId: "C-001", factId: "F-001", label: "C1", status: "upstream-research-memo-conclusion", createsClaimMap: false, elements: [{ label: "Element A" }] }] }),
      fact({ factId: "F-002", factText: "Second fact", sourceLinks: [sourceLink({ sourceLinkId: "F-002-SRC-001", receiptId: "R-002", sourcePath: "Vault/second.md" })], claimLinks: [{ claimLinkId: "F-002-CLM-001", conclusionId: "C-001", factId: "F-002", label: "C1", status: "upstream-research-memo-conclusion", createsClaimMap: false, elements: [{ label: "Element B" }] }], citationStatus: [citationStatus({ citationStatusId: "F-002-CIT-HUMAN", factId: "F-002", authorityRecordId: undefined, status: "needs-human-citation-verification" })] }),
    ] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    const elementA = result.elements.find((element) => element.label === "Element A");
    const elementB = result.elements.find((element) => element.label === "Element B");
    expect(elementA?.allegationIds).toEqual(["ALG-001"]);
    expect(elementB?.allegationIds).toEqual(["ALG-002"]);
    expect(result.allegations.find((allegation) => allegation.allegationId === "ALG-001")?.factId).toBe("F-001");
    expect(result.allegations.find((allegation) => allegation.allegationId === "ALG-002")?.factId).toBe("F-002");
  });

  it("preserves unmapped facts under a placeholder element instead of dropping lineage", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [
      fact({ claimLinks: [{ claimLinkId: "F-001-CLM-001", conclusionId: "C-001", factId: "F-001", label: "C1", status: "upstream-research-memo-conclusion", createsClaimMap: false, elements: ["Element A"] }] }),
      fact({ factId: "F-002", factText: "Unmapped but source-linked fact", sourceLinks: [sourceLink({ sourceLinkId: "F-002-SRC-001", receiptId: "R-002", sourcePath: "Vault/unmapped.md" })], claimLinks: [{ claimLinkId: "F-002-CLM-001", conclusionId: "C-001", factId: "F-002", label: "C1", status: "upstream-research-memo-conclusion", createsClaimMap: false }], citationStatus: [citationStatus({ citationStatusId: "F-002-CIT-HUMAN", factId: "F-002", authorityRecordId: undefined, status: "needs-human-citation-verification" })] }),
    ] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    const placeholder = result.elements.find((element) => element.label === "Legal element pending authority-backed extraction");
    expect(placeholder?.allegationIds).toEqual(["ALG-002"]);
    expect(result.allegations.find((allegation) => allegation.allegationId === "ALG-002")).toMatchObject({ factId: "F-002", receiptIds: ["R-002"], sourcePaths: ["Vault/unmapped.md"] });
    expect(placeholder?.missingProofIds.length).toBeGreaterThan(0);
  });

  it("creates unresolved placeholder claim groups when no conclusion ID exists", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ claimLinks: [{ claimLinkId: "F-001-CLM-001", factId: "F-001", label: "No conclusion", status: "unresolved-placeholder", createsClaimMap: false }] })] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.claims[0]).toMatchObject({ claimId: "CM-001", conclusionId: undefined, unresolvedDraftOnly: true });
    expect(result.claims[0].label).toContain("Unresolved placeholder claim group");
  });

  it("keeps unresolved authorities and missing source paths in missing-proof rows", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ sourceLinks: [], confidence: "unsupported", citationStatus: [citationStatus({ status: "missing-source-link", unresolved: true, authorityRecordId: undefined, receiptId: undefined, message: "No accepted source path is linked." }), citationStatus({ citationStatusId: "F-001-CIT-AUTH-CL-404", status: "unresolved-authority-lookup-record", unresolved: true, authorityRecordId: "CL-404" })] })] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.supportingEvidence).toHaveLength(0);
    expect(result.missingProof.map((proof) => proof.scope)).toEqual(expect.arrayContaining(["source", "authority", "citation"]));
    expect(result.status).toBe("partial");
  });

  it("turns fact-level diagnostics into allegation-linked missing-proof rows", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ diagnostics: [{ code: "fact-gap", severity: "warning", message: "Needs source review", factId: "F-001" }] })] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "fact-gap")).toBe(true);
    expect(result.missingProof.some((proof) => proof.allegationId === "ALG-001" && proof.reason.includes("fact-gap"))).toBe(true);
  });

  it("does not silently drop malformed source links when another source link is valid", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ sourceLinks: [sourceLink(), sourceLink({ sourceLinkId: "F-001-SRC-002", receiptId: "R-BAD", sourcePath: undefined })] })] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.supportingEvidence).toHaveLength(1);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-claim-map-source-link" && diagnostic.factId === "F-001")).toBe(true);
    expect(result.missingProof.some((proof) => proof.allegationId === "ALG-001" && proof.reason.includes("invalid-claim-map-source-link"))).toBe(true);
  });
});

describe("claim map document generation", () => {
  it("builds markdown and metadata with claim, element, allegation, evidence, and missing-proof mappings", async () => {
    const store = new FakeTaskStore();
    seedLedger(store);
    const result = await generateCounterLawsuitClaimMap({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    const doc = store.documents.get(`FN-3:${CLAIM_MAP_DOCUMENT_KEY}`);
    expect(result.status).toBe("partial");
    expect(doc?.content).toContain("Claim table");
    expect(doc?.content).toContain("Element matrix");
    expect(doc?.content).toContain("Allegation-to-evidence matrix");
    expect(doc?.content).toContain("Missing-proof register");
    expect(doc?.content).toContain("not filing-ready");
    expect(doc?.metadata).toMatchObject({ runId: "CLW-1", claims: expect.any(Array), elements: expect.any(Array), allegations: expect.any(Array), supportingEvidence: expect.any(Array), missingProof: expect.any(Array) });
  });

  it("writes status documents for blocked, partial, and failed states", async () => {
    const blocked = new FakeTaskStore();
    await generateCounterLawsuitClaimMap({ taskStore: blocked as never, runId: "CLW-1" });
    expect(blocked.documents.get(`FN-3:${CLAIM_MAP_DOCUMENT_KEY}`)?.content).toContain("Status: blocked");
    expect(blocked.documents.get(`FN-3:${CLAIM_MAP_STATUS_DOCUMENT_KEY}`)?.content).toContain("Status: blocked");

    const partial = new FakeTaskStore();
    seedLedger(partial);
    await generateCounterLawsuitClaimMap({ taskStore: partial as never, runId: "CLW-1" });
    expect(partial.documents.get(`FN-3:${CLAIM_MAP_STATUS_DOCUMENT_KEY}`)?.content).toContain("Status: partial");

    const failed = new FakeTaskStore();
    seedLedger(failed);
    failed.failNextClaimMapUpsert = true;
    const failedResult = await generateCounterLawsuitClaimMap({ taskStore: failed as never, runId: "CLW-1" });
    expect(failedResult.status).toBe("failed");
    const serialized = JSON.stringify([...failed.documents.values()]);
    expect(serialized).not.toContain("super-secret-token-value");
    expect(failed.documents.get(`FN-3:${CLAIM_MAP_STATUS_DOCUMENT_KEY}`)?.content).toContain("Status: failed");
  });

  it("derives status from persisted claim-map and claim-map-status documents", async () => {
    const store = new FakeTaskStore();
    seedLedger(store);
    const result = await generateCounterLawsuitClaimMap({ taskStore: store as never, runId: "CLW-1" });
    const summary = await deriveClaimMapStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary).toMatchObject({ runId: "CLW-1", status: result.status, claimMapDocumentKey: CLAIM_MAP_DOCUMENT_KEY, statusDocumentKey: CLAIM_MAP_STATUS_DOCUMENT_KEY, claimCount: result.counts.claims, missingProofCount: result.counts.missingProof });
  });

  it("does not report malformed persisted claim maps as completed", async () => {
    const store = new FakeTaskStore();
    store.setDocument("FN-3", CLAIM_MAP_DOCUMENT_KEY, "# no manifest", undefined);
    const summary = await deriveClaimMapStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary.status).toBe("failed");
    expect(summary.claimMapDocumentKey).toBe(CLAIM_MAP_DOCUMENT_KEY);
    expect(summary.diagnostics.map((diagnostic) => diagnostic.code)).toContain("malformed-manifest");
  });

  it("returns not-run status for older runs without a claim-map stage", async () => {
    const store = new FakeTaskStore();
    store.tasks = store.tasks.filter((task) => task.sourceMetadata?.workflowStage !== "claim-map");
    const summary = await deriveClaimMapStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary).toMatchObject({ status: "not-run", claimMapDocumentKey: undefined, claimCount: 0, safetyNotice: expect.stringContaining("Draft-only") });
  });

  it("keeps generated markdown bounded and redacted", async () => {
    const store = new FakeTaskStore();
    seedLedger(store, { facts: [fact({ factText: `Authorization: Bearer ghp123456789secret ${"x".repeat(2000)}` })] });
    const result = await collectCounterLawsuitClaimMapInputs({ taskStore: store as never, runId: "CLW-1" });
    const markdown = buildClaimMapMarkdown(result);
    expect(markdown).not.toContain("ghp123456789secret");
    expect(markdown.length).toBeLessThan(50000);
  });
});
