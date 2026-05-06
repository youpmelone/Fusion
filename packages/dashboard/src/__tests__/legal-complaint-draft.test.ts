import { describe, expect, it } from "vitest";
import type { Task, TaskDocument } from "@fusion/core";
const CLAIM_MAP_DOCUMENT_KEY = "claim-map";
const CLAIM_MAP_STATUS_DOCUMENT_KEY = "claim-map-status";

import {
  DRAFT_COMPLAINT_DOCUMENT_KEY,
  DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
  buildComplaintDraftMarkdown,
  collectCounterLawsuitComplaintDraftInputs,
  deriveComplaintDraftStatusForRun,
  generateCounterLawsuitComplaintDraft,
  locateCounterLawsuitComplaintDraftStageTasks,
} from "../legal-complaint-draft.js";

function makeTask(id: string, stage: string, runId = "CLW-1"): Task {
  const stageIndex = stage === "research-memo" ? 0 : stage === "evidence-ledger" ? 1 : stage === "claim-map" ? 2 : 3;
  const documentKey = stage === "claim-map" ? CLAIM_MAP_DOCUMENT_KEY : stage === "draft-counter-lawsuit-complaint" ? DRAFT_COMPLAINT_DOCUMENT_KEY : stage;
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

class FakeTaskStore {
  tasks: Task[] = [makeTask("FN-3", "claim-map"), makeTask("FN-4", "draft-counter-lawsuit-complaint")];
  documents = new Map<string, TaskDocument>();
  failNextDraftUpsert = false;

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }): Promise<TaskDocument> {
    if (this.failNextDraftUpsert && input.key === DRAFT_COMPLAINT_DOCUMENT_KEY) {
      this.failNextDraftUpsert = false;
      throw new Error("writer failed --obsidian-api-key super-secret-token-value Authorization: Bearer abcdefghijklmnop");
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

function claimMapManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "CLW-1",
    generatedAt: "2026-05-06T01:00:00.000Z",
    status: "completed",
    sourceDocuments: [],
    claimMapTaskId: "FN-3",
    claims: [
      {
        claimId: "CM-002",
        label: "Research memo conclusion B",
        status: "supported-draft",
        elementIds: ["EL-002"],
        allegationIds: ["ALG-002"],
        supportingEvidenceIds: ["SE-002"],
        authorityRecordIds: ["CL-002"],
        citationStatusIds: ["CIT-002"],
        missingProofIds: [],
        unresolvedDraftOnly: false,
        verified: false,
      },
      {
        claimId: "CM-001",
        label: "Research memo conclusion A",
        status: "partial-draft",
        elementIds: ["EL-001"],
        allegationIds: ["ALG-001"],
        supportingEvidenceIds: ["SE-001"],
        authorityRecordIds: ["CL-001"],
        citationStatusIds: ["CIT-001"],
        missingProofIds: ["MP-001"],
        unresolvedDraftOnly: true,
        verified: false,
      },
    ],
    elements: [
      { elementId: "EL-001", claimId: "CM-001", label: "Element A", status: "partial-draft", allegationIds: ["ALG-001"], supportingEvidenceIds: ["SE-001"], authorityRecordIds: ["CL-001"], citationStatusIds: ["CIT-001"], missingProofIds: ["MP-001"], invented: false, verified: false },
      { elementId: "EL-002", claimId: "CM-002", label: "Element B", status: "supported-draft", allegationIds: ["ALG-002"], supportingEvidenceIds: ["SE-002"], authorityRecordIds: ["CL-002"], citationStatusIds: ["CIT-002"], missingProofIds: [], invented: false, verified: false },
    ],
    allegations: [
      {
        allegationId: "ALG-002",
        claimId: "CM-002",
        elementId: "EL-002",
        factId: "F-002",
        allegationText: "Source-linked receipts suggest a second candidate factual issue.",
        supportingEvidenceIds: ["SE-002"],
        sourceLinkIds: ["SRC-002"],
        receiptIds: ["R-002"],
        sourcePaths: ["Vault/b.md"],
        authorityRecordIds: ["CL-002"],
        citationStatusIds: ["CIT-002"],
        upstreamConfidence: "medium",
        verified: false,
        unresolvedDraftOnly: false,
      },
      {
        allegationId: "ALG-001",
        claimId: "CM-001",
        elementId: "EL-001",
        factId: "F-001",
        allegationText: "Source-linked receipts suggest a candidate factual issue about diverted payments --qmd-token should-redact-token-value.",
        supportingEvidenceIds: ["SE-001"],
        sourceLinkIds: ["SRC-001"],
        receiptIds: ["R-001"],
        sourcePaths: ["Vault/a.md"],
        authorityRecordIds: ["CL-001"],
        citationStatusIds: ["CIT-001"],
        upstreamConfidence: "high",
        verified: false,
        unresolvedDraftOnly: true,
      },
    ],
    supportingEvidence: [
      { supportingEvidenceId: "SE-001", claimId: "CM-001", elementId: "EL-001", allegationId: "ALG-001", factId: "F-001", sourceLinkId: "SRC-001", receiptId: "R-001", sourcePath: "Vault/a.md", citationStatusIds: ["CIT-001"], verified: false },
      { supportingEvidenceId: "SE-002", claimId: "CM-002", elementId: "EL-002", allegationId: "ALG-002", factId: "F-002", sourceLinkId: "SRC-002", receiptId: "R-002", sourcePath: "Vault/b.md", citationStatusIds: ["CIT-002"], verified: false },
    ],
    missingProof: [
      { missingProofId: "MP-001", scope: "element", severity: "warning", reason: "Human citation review is still required.", claimId: "CM-001", elementId: "EL-001", allegationId: "ALG-001", factId: "F-001", citationStatusId: "CIT-001", unresolved: true },
    ],
    diagnostics: [],
    counts: { claims: 2, elements: 2, allegations: 2, supportingEvidence: 2, missingProof: 1, unresolvedGaps: 1 },
    safetyNotice: "Draft-only structured claim map generated from the persisted evidence ledger manifest. It is source-linked only, unverified, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing.",
    ...overrides,
  };
}

function seedClaimMap(store: FakeTaskStore, options: { metadata?: boolean; manifest?: Record<string, unknown> } = {}): Record<string, unknown> {
  const manifest = options.manifest ?? claimMapManifest();
  store.setDocument("FN-3", CLAIM_MAP_DOCUMENT_KEY, `# claim map\n\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``, options.metadata === false ? undefined : manifest);
  return manifest;
}

describe("complaint draft input collection", () => {
  it("locates claim-map and draft complaint tasks by workflow metadata", async () => {
    const store = new FakeTaskStore();
    const located = await locateCounterLawsuitComplaintDraftStageTasks({ taskStore: store as never, runId: "CLW-1" });
    expect(located.claimMapTask.id).toBe("FN-3");
    expect(located.draftComplaintTask.id).toBe("FN-4");
    expect(located.tasks.map((task) => task.id)).toEqual(["FN-3", "FN-4"]);
  });

  it("prefers claim-map document metadata over JSON block content", async () => {
    const store = new FakeTaskStore();
    const metadataManifest = claimMapManifest({ allegations: [{ ...claimMapManifest().allegations[0] as Record<string, unknown>, allegationId: "ALG-META", factId: "F-META" }] });
    const jsonManifest = claimMapManifest({ allegations: [{ ...claimMapManifest().allegations[0] as Record<string, unknown>, allegationId: "ALG-JSON", factId: "F-JSON" }] });
    store.setDocument("FN-3", CLAIM_MAP_DOCUMENT_KEY, `# claim map\n\n\`\`\`json\n${JSON.stringify(jsonManifest)}\n\`\`\``, metadataManifest);
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.paragraphs[0].allegationId).toBe("ALG-META");
    expect(JSON.stringify(result)).not.toContain("ALG-JSON");
  });

  it("falls back to the machine-readable JSON block when metadata is absent", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store, { metadata: false });
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.paragraphs.map((paragraph) => paragraph.receiptIds[0])).toEqual(["R-001", "R-002"]);
    expect(result.sourceReferences.map((source) => source.receiptIds[0])).toEqual(["R-001", "R-002"]);
  });

  it("turns missing or malformed claim maps into blocked draft diagnostics", async () => {
    const missing = new FakeTaskStore();
    const missingResult = await collectCounterLawsuitComplaintDraftInputs({ taskStore: missing as never, runId: "CLW-1" });
    expect(missingResult.status).toBe("blocked");
    expect(missingResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("draft-complaint-source-missing");
    expect(missingResult.paragraphs).toHaveLength(0);

    const malformed = new FakeTaskStore();
    malformed.setDocument("FN-3", CLAIM_MAP_DOCUMENT_KEY, "# no manifest", undefined);
    const malformedResult = await collectCounterLawsuitComplaintDraftInputs({ taskStore: malformed as never, runId: "CLW-1" });
    expect(malformedResult.status).toBe("blocked");
    expect(malformedResult.diagnostics.some((diagnostic) => diagnostic.code === "draft-complaint-manifest-malformed")).toBe(true);
  });

  it("keeps claim-map-status blockers authoritative over a completed primary manifest", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store, { manifest: claimMapManifest({ status: "completed", missingProof: [] }) });
    store.setDocument("FN-3", CLAIM_MAP_STATUS_DOCUMENT_KEY, "# status", { status: "blocked", diagnostics: [{ code: "claim-map-blocked", severity: "error", message: "blocked" }] });
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.statusDocumentKey).toBe(DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "draft-complaint-claim-map-unresolved")).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.sourceDocumentKey === CLAIM_MAP_STATUS_DOCUMENT_KEY)).toBe(true);
  });

  it("returns not-run for older workflow runs without a draft complaint stage", async () => {
    const store = new FakeTaskStore();
    store.tasks = [makeTask("FN-3", "claim-map")];
    const summary = await deriveComplaintDraftStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary.status).toBe("not-run");
    expect(summary.draftComplaintDocumentKey).toBeUndefined();
  });
});

describe("complaint draft scaffold", () => {
  it("uses deterministic paragraph ordering and placeholder pleading sections", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store);
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.paragraphs.map((paragraph) => paragraph.allegationId)).toEqual(["ALG-001", "ALG-002"]);
    expect(result.paragraphs.map((paragraph) => paragraph.paragraphNumber)).toEqual([1, 2]);
    expect(result.sections.find((section) => section.sectionId === "caption-placeholder")?.title).toContain("Caption");
    expect(result.sections.find((section) => section.sectionId === "requested-relief-placeholder")?.title).toContain("Requested relief");
  });

  it("preserves source, receipt, support, authority, citation, verification, and filing flags", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store);
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.paragraphs[0]).toMatchObject({
      claimId: "CM-001",
      elementId: "EL-001",
      allegationId: "ALG-001",
      factId: "F-001",
      sourcePaths: ["Vault/a.md"],
      receiptIds: ["R-001"],
      supportingEvidenceIds: ["SE-001"],
      authorityRecordIds: ["CL-001"],
      citationStatusIds: ["CIT-001"],
      verified: false,
      filingReady: false,
    });
    expect(result.sourceReferences[0]).toMatchObject({ receiptIds: ["R-001"], sourcePath: "Vault/a.md", verified: false });
  });

  it("clearly blocks unsupported allegations instead of treating them as support", async () => {
    const store = new FakeTaskStore();
    const manifest = claimMapManifest({
      supportingEvidence: [],
      allegations: [{ ...(claimMapManifest().allegations[0] as Record<string, unknown>), supportingEvidenceIds: [], receiptIds: [], sourcePaths: [] }],
      missingProof: [{ missingProofId: "MP-SOURCE", scope: "source", severity: "error", reason: "Missing source path", claimId: "CM-002", elementId: "EL-002", allegationId: "ALG-002", factId: "F-002", unresolved: true }],
    });
    seedClaimMap(store, { manifest });
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.paragraphs[0].text).toContain("BLOCKED DRAFT PARAGRAPH");
    expect(result.paragraphs[0].unresolvedDraftOnly).toBe(true);
    expect(result.status).toBe("partial");
  });

  it("does not expand upstream claim labels into invented legal theories", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store, { manifest: claimMapManifest({ claims: [{ ...(claimMapManifest().claims[0] as Record<string, unknown>), label: "Research memo conclusion only" }] }) });
    const result = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.claimDrafts[0].label).toBe("Research memo conclusion only");
    expect(JSON.stringify(result.claimDrafts)).not.toContain("Fraud");
    expect(JSON.stringify(result.claimDrafts)).not.toContain("Breach");
  });

  it("redacts token-like strings from rows, diagnostics, markdown, and persisted metadata", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store);
    const result = await generateCounterLawsuitComplaintDraft({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    const doc = store.documents.get(`FN-4:${DRAFT_COMPLAINT_DOCUMENT_KEY}`);
    const serialized = JSON.stringify({ result, content: doc?.content, metadata: doc?.metadata });
    expect(serialized).not.toContain("should-redact-token-value");
    expect(serialized).toContain("--qmd-token [REDACTED]");
  });
});

describe("complaint draft persistence and status derivation", () => {
  it("writes primary markdown, manifest metadata, and status documents for unresolved drafts", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store);
    const result = await generateCounterLawsuitComplaintDraft({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    const doc = store.documents.get(`FN-4:${DRAFT_COMPLAINT_DOCUMENT_KEY}`);
    const statusDoc = store.documents.get(`FN-4:${DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY}`);
    expect(result.status).toBe("partial");
    expect(doc?.content).toContain("Caption placeholder");
    expect(doc?.content).toContain("Draft claims or counterclaims");
    expect(doc?.content).toContain("Source and citation appendix");
    expect(doc?.content).toContain('"filingReady": false');
    expect(doc?.metadata).toMatchObject({ runId: "CLW-1", paragraphs: expect.any(Array), claimDrafts: expect.any(Array), sourceReferences: expect.any(Array), missingProof: expect.any(Array) });
    expect(statusDoc?.metadata).toMatchObject({ status: "partial", statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY });
  });

  it("always writes the primary draft document even when the claim map is missing", async () => {
    const store = new FakeTaskStore();
    const result = await generateCounterLawsuitComplaintDraft({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(store.documents.get(`FN-4:${DRAFT_COMPLAINT_DOCUMENT_KEY}`)?.content).toContain("Status: blocked");
    expect(store.documents.get(`FN-4:${DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY}`)?.content).toContain("Status: blocked");
  });

  it("surfaces writer failures as redacted failed status documents", async () => {
    const store = new FakeTaskStore();
    seedClaimMap(store);
    store.failNextDraftUpsert = true;
    const result = await generateCounterLawsuitComplaintDraft({ taskStore: store as never, runId: "CLW-1" });
    const statusDoc = store.documents.get(`FN-4:${DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY}`);
    expect(result.status).toBe("failed");
    expect(statusDoc?.content).toContain("draft-complaint-generation-failed");
    expect(JSON.stringify(statusDoc)).not.toContain("super-secret-token-value");
    expect(JSON.stringify(statusDoc)).not.toContain("abcdefghijklmnop");
  });

  it("derives status from status documents before stale primary manifests", async () => {
    const store = new FakeTaskStore();
    const completed = await collectCounterLawsuitComplaintDraftInputs({ taskStore: store as never, runId: "CLW-1" });
    store.setDocument("FN-4", DRAFT_COMPLAINT_DOCUMENT_KEY, buildComplaintDraftMarkdown({ ...completed, status: "completed" }), { ...completed, status: "completed", counts: completed.counts });
    store.setDocument("FN-4", DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY, "# status", { status: "blocked", paragraphCount: 0, diagnostics: [{ code: "blocked", severity: "error", message: "blocked" }] });
    const summary = await deriveComplaintDraftStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary.status).toBe("blocked");
    expect(summary.statusDocumentKey).toBe(DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY);
    expect(summary.diagnostics[0].code).toBe("blocked");
  });

  it("reports malformed primary draft documents as failed instead of completed", async () => {
    const store = new FakeTaskStore();
    store.setDocument("FN-4", DRAFT_COMPLAINT_DOCUMENT_KEY, "# no manifest", undefined);
    const summary = await deriveComplaintDraftStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary.status).toBe("failed");
    expect(summary.diagnostics.some((diagnostic) => diagnostic.code === "draft-complaint-manifest-malformed")).toBe(true);
  });
});
