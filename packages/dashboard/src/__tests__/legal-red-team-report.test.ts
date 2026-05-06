import { describe, expect, it } from "vitest";
import type { Task, TaskDocument } from "@fusion/core";
import { CLAIM_MAP_DOCUMENT_KEY } from "../legal-claim-map.js";
import {
  RED_TEAM_REPORT_DOCUMENT_KEY,
  RED_TEAM_REPORT_SAFETY_NOTICE,
  RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
  buildRedTeamReportMarkdown,
  collectCounterLawsuitRedTeamInputs,
  deriveRedTeamReportStatusForRun,
  generateCounterLawsuitRedTeamReport,
  locateCounterLawsuitRedTeamStageTasks,
  redTeamSummaryFromResult,
} from "../legal-red-team-report.js";

const DRAFT_COMPLAINT_DOCUMENT_KEY = "draft-counter-lawsuit-complaint";
const DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY = "draft-counter-lawsuit-complaint-status";

function makeTask(id: string, stage: string, runId = "CLW-1", stageIndex?: number): Task {
  const index = stageIndex ?? (stage === "claim-map" ? 2 : stage === "draft-counter-lawsuit-complaint" ? 3 : 4);
  const documentKey = stage === "claim-map" ? CLAIM_MAP_DOCUMENT_KEY : stage === "draft-counter-lawsuit-complaint" ? DRAFT_COMPLAINT_DOCUMENT_KEY : RED_TEAM_REPORT_DOCUMENT_KEY;
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
      workflowStageIndex: index,
      documentKey,
    },
  } as Task;
}

class FakeTaskStore {
  tasks: Task[] = [makeTask("FN-3", "claim-map"), makeTask("FN-4", "draft-counter-lawsuit-complaint"), makeTask("FN-5", "opposing-counsel-red-team-report")];
  documents = new Map<string, TaskDocument>();

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; metadata?: Record<string, unknown>; author?: string }): Promise<TaskDocument> {
    const document = {
      id: `${taskId}:${input.key}`,
      taskId,
      key: input.key,
      content: input.content,
      revision: 1,
      author: input.author ?? "test",
      metadata: input.metadata,
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument;
    this.documents.set(`${taskId}:${input.key}`, document);
    return document;
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

function complaintManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "CLW-1",
    generatedAt: "2026-05-06T01:00:00.000Z",
    status: "completed",
    sourceDocuments: [],
    claimMapTaskId: "FN-3",
    draftComplaintTaskId: "FN-4",
    draftComplaintDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    statusDocumentKey: DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY,
    sections: [{ sectionId: "SEC-001", title: "Safety notice" }],
    paragraphs: [
      { paragraphId: "P-002", claimId: "CM-2", claimDraftId: "CD-002", sourcePaths: ["Vault/B.md"], receiptIds: ["R-002"], citationStatusIds: ["CIT-002"], authorityRecordIds: ["CL-002"] },
      { paragraphId: "P-001", claimId: "CM-1", claimDraftId: "CD-001", sourcePaths: ["Vault/A.md"], receiptIds: ["R-001"], citationStatusIds: ["CIT-001"], authorityRecordIds: ["CL-001"] },
    ],
    claimDrafts: [
      { claimDraftId: "CD-002", sourcePaths: ["Vault/B.md"] },
      { claimDraftId: "CD-001", sourcePaths: ["Vault/A.md"] },
    ],
    sourceReferences: [
      { sourceReferenceId: "SRC-002", sourcePath: "Vault/B.md", receiptId: "R-002" },
      { sourceReferenceId: "SRC-001", sourcePath: "Vault/A.md", receiptId: "R-001" },
    ],
    missingProof: [{ missingProofId: "MP-001", unresolved: true, reason: "Jurisdiction placeholder remains unresolved." }],
    diagnostics: [],
    counts: { sections: 1, paragraphs: 2, claimDrafts: 2, sourceReferences: 2, missingProof: 1, unresolvedGaps: 1 },
    safetyNotice: "Draft-only complaint scaffold; not legal advice, not good-law verification, not citation-format validation, not filing-ready.",
    ...overrides,
  };
}

function seedComplaint(store: FakeTaskStore, options: { metadata?: boolean; manifest?: Record<string, unknown>; status?: string; statusMetadata?: Record<string, unknown> } = {}): Record<string, unknown> {
  const manifest = options.manifest ?? complaintManifest();
  store.setDocument("FN-4", DRAFT_COMPLAINT_DOCUMENT_KEY, `# complaint\n\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``, options.metadata === false ? undefined : manifest);
  if (options.status) {
    const statusManifest = options.statusMetadata ?? {
      runId: "CLW-1",
      status: options.status,
      diagnostics: [{ code: "draft-blocked", severity: "error", message: "Draft complaint status is blocked --auth-token secret-token-value" }],
    };
    store.setDocument("FN-4", DRAFT_COMPLAINT_STATUS_DOCUMENT_KEY, `# status\n\n\`\`\`json\n${JSON.stringify(statusManifest)}\n\`\`\``, statusManifest);
  }
  return manifest;
}

describe("red-team report input collection", () => {
  it("locates claim-map, draft complaint, and red-team tasks by workflow metadata in deterministic order", async () => {
    const store = new FakeTaskStore();
    store.tasks = [makeTask("FN-5", "opposing-counsel-red-team-report", "CLW-1", 4), makeTask("FN-3", "claim-map", "CLW-1", 2), makeTask("FN-4", "draft-counter-lawsuit-complaint", "CLW-1", 3)];
    const located = await locateCounterLawsuitRedTeamStageTasks({ taskStore: store as never, runId: "CLW-1" });
    expect(located.claimMapTask?.id).toBe("FN-3");
    expect(located.draftComplaintTask?.id).toBe("FN-4");
    expect(located.redTeamTask?.id).toBe("FN-5");
    expect(located.tasks.map((task) => task.id)).toEqual(["FN-3", "FN-4", "FN-5"]);
  });

  it("prefers complaint draft metadata over JSON block content", async () => {
    const store = new FakeTaskStore();
    const metadataManifest = complaintManifest({ counts: { paragraphs: 1, claimDrafts: 1, sourceReferences: 1, unresolvedGaps: 0 }, paragraphs: [{ paragraphId: "P-META", sourcePaths: ["Vault/meta.md"] }] });
    const jsonManifest = complaintManifest({ counts: { paragraphs: 9, claimDrafts: 9, sourceReferences: 9, unresolvedGaps: 9 }, paragraphs: [{ paragraphId: "P-JSON", sourcePaths: ["Vault/json.md"] }] });
    store.setDocument("FN-4", DRAFT_COMPLAINT_DOCUMENT_KEY, `# complaint\n\n\`\`\`json\n${JSON.stringify(jsonManifest)}\n\`\`\``, metadataManifest);
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === DRAFT_COMPLAINT_DOCUMENT_KEY)?.parsedFrom).toBe("metadata");
    expect(result.counts.reviewedParagraphs).toBe(1);
    expect(JSON.stringify(result)).not.toContain("P-JSON");
  });

  it("falls back to the complaint draft machine-readable JSON block when metadata is absent", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, { metadata: false, manifest: complaintManifest({ counts: { paragraphs: 3, claimDrafts: 2, sourceReferences: 1, unresolvedGaps: 0 } }) });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.sourceDocuments.find((doc) => doc.key === DRAFT_COMPLAINT_DOCUMENT_KEY)?.parsedFrom).toBe("json-block");
    expect(result.counts.reviewedParagraphs).toBe(3);
    expect(result.counts.reviewedClaims).toBe(2);
  });

  it("turns a missing complaint draft into a blocked diagnostic summary", async () => {
    const store = new FakeTaskStore();
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.statusDocumentKey).toBe(RED_TEAM_REPORT_STATUS_DOCUMENT_KEY);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing-document");
    expect(redTeamSummaryFromResult(result)).toMatchObject({ status: "blocked", reviewedParagraphCount: 0 });
  });

  it("writes a fresh primary report and status when complaint artifacts are missing", async () => {
    const store = new FakeTaskStore();
    const result = await generateCounterLawsuitRedTeamReport({ taskStore: store as never, runId: "CLW-1" });
    const report = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_DOCUMENT_KEY);
    const status = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_STATUS_DOCUMENT_KEY);
    expect(result.status).toBe("blocked");
    expect(report?.content).toContain("No reviewable draft complaint manifest was available");
    expect(report?.metadata).toMatchObject({ status: "blocked", draftComplaintTaskId: "FN-4", redTeamTaskId: "FN-5" });
    expect(status?.metadata).toMatchObject({ status: "blocked", redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY });
  });

  it("turns malformed complaint draft manifests into blocked diagnostics instead of throwing", async () => {
    const store = new FakeTaskStore();
    store.setDocument("FN-4", DRAFT_COMPLAINT_DOCUMENT_KEY, "# no manifest", undefined);
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("malformed-manifest");
  });

  it("lets draft complaint status documents take precedence over completed primary manifests", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, { status: "blocked" });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("draft-complaint-status-blocker");
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("returns not-run for older runs that do not have a red-team stage", async () => {
    const store = new FakeTaskStore();
    store.tasks = [makeTask("FN-3", "claim-map"), makeTask("FN-4", "draft-counter-lawsuit-complaint")];
    seedComplaint(store);
    const collected = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(collected.status).toBe("not-run");
    expect(redTeamSummaryFromResult(collected)).toMatchObject({ status: "not-run", redTeamReportDocumentKey: undefined });
    await expect(deriveRedTeamReportStatusForRun({ taskStore: store as never, runId: "CLW-1" })).resolves.toMatchObject({ status: "not-run" });
  });

  it("derives red-team status from persisted status documents before primary documents", async () => {
    const store = new FakeTaskStore();
    const reportManifest = { runId: "CLW-1", status: "completed", counts: { findings: 8, mtdAttacks: 1, citationIssues: 1, revisionRecommendations: 1, unresolvedBlockers: 0, reviewedParagraphs: 2, reviewedClaims: 2 }, diagnostics: [] };
    const statusManifest = { runId: "CLW-1", status: "failed", findingCount: 0, mtdAttackCount: 0, citationIssueCount: 0, revisionRecommendationCount: 0, unresolvedBlockerCount: 1, reviewedParagraphCount: 0, reviewedClaimCount: 0, diagnostics: [{ code: "red-team-failed", severity: "error", message: "Report failed" }] };
    store.setDocument("FN-5", RED_TEAM_REPORT_DOCUMENT_KEY, `# report\n\n\`\`\`json\n${JSON.stringify(reportManifest)}\n\`\`\``, reportManifest);
    store.setDocument("FN-5", RED_TEAM_REPORT_STATUS_DOCUMENT_KEY, "# status", statusManifest);
    const summary = await deriveRedTeamReportStatusForRun({ taskStore: store as never, runId: "CLW-1" });
    expect(summary).toMatchObject({ status: "failed", findingCount: 0, unresolvedBlockerCount: 1, redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY });
  });

  it("keeps count derivation deterministic and source paths de-duplicated", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, { manifest: complaintManifest({ counts: undefined }) });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.counts).toMatchObject({ reviewedParagraphs: 2, reviewedClaims: 2, sourceReferences: 2, sourcePaths: 2, unresolvedBlockers: 1 });
  });

  it("bounds and redacts token-like upstream text in diagnostics", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, {
      manifest: complaintManifest({
        diagnostics: [{
          code: "provider-error",
          severity: "warning",
          message: `Provider failed with --obsidian-api-key super-secret-token-value and ${"long ".repeat(300)}`,
        }],
      }),
    });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("super-secret-token-value");
    expect(result.diagnostics[0].message.length).toBeLessThanOrEqual(500);
  });

  it("persists the red-team report and status documents from persisted complaint documents only", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, { status: "blocked" });
    const result = await generateCounterLawsuitRedTeamReport({ taskStore: store as never, runId: "CLW-1", force: true });
    expect(result.status).toBe("blocked");
    const report = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_DOCUMENT_KEY);
    const status = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_STATUS_DOCUMENT_KEY);
    expect(report?.content).toContain("Opposing-counsel red-team report");
    expect(report?.content).toContain("Motion-to-dismiss risk matrix");
    expect(report?.metadata).toMatchObject({ runId: "CLW-1", redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY });
    expect(report?.metadata).toMatchObject({
      findings: expect.any(Array),
      mtdAttacks: expect.any(Array),
      citationIssues: expect.any(Array),
      revisionRecommendations: expect.any(Array),
      statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
    });
    expect(status?.content).toContain("Status: blocked");
    expect(status?.metadata).toMatchObject({ status: "blocked", reviewedParagraphCount: 2 });
    await expect(deriveRedTeamReportStatusForRun({ taskStore: store as never, runId: "CLW-1" })).resolves.toMatchObject({ status: "blocked", redTeamReportDocumentKey: RED_TEAM_REPORT_DOCUMENT_KEY });
  });

  it("writes status documents for partial, stale, and failed upstream complaint states", async () => {
    const cases = [
      { status: undefined, expected: "partial" },
      { status: "stale", expected: "stale" },
      { status: "failed", expected: "blocked" },
    ] as const;
    for (const entry of cases) {
      const store = new FakeTaskStore();
      seedComplaint(store, { status: entry.status });
      const result = await generateCounterLawsuitRedTeamReport({ taskStore: store as never, runId: "CLW-1" });
      const report = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_DOCUMENT_KEY);
      const status = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_STATUS_DOCUMENT_KEY);
      expect(result.status).toBe(entry.expected);
      expect(report?.content).toContain("Machine-readable JSON manifest");
      expect(status?.metadata).toMatchObject({ status: entry.expected, statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY });
    }
  });

  it("persists bounded redacted report and status content when upstream text contains secrets", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, {
      manifest: complaintManifest({
        missingProof: [{ missingProofId: "MP-SECRET", reason: `Jurisdiction blocked by --auth-token top-secret-token-value and ${"very long ".repeat(200)}` }],
      }),
      status: "blocked",
    });
    await generateCounterLawsuitRedTeamReport({ taskStore: store as never, runId: "CLW-1" });
    const report = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_DOCUMENT_KEY);
    const status = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_STATUS_DOCUMENT_KEY);
    const serialized = JSON.stringify({ report: report?.content, reportMetadata: report?.metadata, status: status?.content, statusMetadata: status?.metadata });
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("top-secret-token-value");
    expect(report?.metadata?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.not.stringContaining("very long ".repeat(80)) }),
    ]));
  });

  it("writes a failed status document with redacted diagnostics if report persistence fails", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store);
    const originalUpsert = store.upsertTaskDocument.bind(store);
    let failedPrimaryWrite = false;
    store.upsertTaskDocument = async (taskId, input) => {
      if (input.key === RED_TEAM_REPORT_DOCUMENT_KEY && !failedPrimaryWrite) {
        failedPrimaryWrite = true;
        throw new Error("write failed with --auth-token secret-token-value");
      }
      return originalUpsert(taskId, input);
    };
    const result = await generateCounterLawsuitRedTeamReport({ taskStore: store as never, runId: "CLW-1" });
    const status = await store.getTaskDocument("FN-5", RED_TEAM_REPORT_STATUS_DOCUMENT_KEY);
    expect(result.status).toBe("failed");
    expect(status?.metadata).toMatchObject({ status: "failed", statusDocumentKey: RED_TEAM_REPORT_STATUS_DOCUMENT_KEY });
    expect(JSON.stringify(status)).toContain("[REDACTED]");
    expect(JSON.stringify(status)).not.toContain("secret-token-value");
  });

  it("builds Markdown with all required report sections, a machine-readable JSON manifest, and safety language", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store);
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    const markdown = buildRedTeamReportMarkdown(result);
    expect(markdown).toContain("Safety boundary");
    expect(markdown).toContain("Run context");
    expect(markdown).toContain("Executive risk summary");
    expect(markdown).toContain("Weakness table");
    expect(markdown).toContain("Motion-to-dismiss risk matrix");
    expect(markdown).toContain("Citation/source issue register");
    expect(markdown).toContain("Paragraph and claim critique");
    expect(markdown).toContain("Revision recommendations");
    expect(markdown).toContain("Unresolved blockers");
    expect(markdown).toContain("Diagnostics");
    expect(markdown).toContain("Machine-readable JSON manifest");
    expect(markdown).toContain("not legal advice");
    expect(markdown).toContain(RED_TEAM_REPORT_DOCUMENT_KEY);
  });

  it("exports the draft-only adversarial safety notice", () => {
    expect(RED_TEAM_REPORT_SAFETY_NOTICE).toContain("Draft-only");
    expect(RED_TEAM_REPORT_SAFETY_NOTICE).toContain("not legal advice");
    expect(RED_TEAM_REPORT_SAFETY_NOTICE).toContain("not filing-ready");
  });
});

describe("red-team report adversarial row generation", () => {
  it("generates MTD draft-risk rows from missing elements and pleading placeholders", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, {
      manifest: complaintManifest({
        sections: [
          { sectionId: "SEC-001", title: "Jurisdiction and venue placeholders", text: "Jurisdiction placeholder; venue placeholder." },
          { sectionId: "SEC-002", title: "Requested relief placeholder", text: "Damages and relief placeholder." },
        ],
        claimDrafts: [{ claimDraftId: "CD-001", elementIds: [], supportIds: [], sourcePaths: ["Vault/A.md"], receiptIds: ["R-001"] }],
        missingProof: [
          { missingProofId: "MP-001", claimDraftId: "CD-001", reason: "Missing element support for claim draft." },
          { missingProofId: "MP-002", reason: "Jurisdiction and venue placeholder remains unresolved." },
          { missingProofId: "MP-003", reason: "Damages and requested relief support missing." },
        ],
      }),
    });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.mtdAttacks.map((attack) => attack.category)).toEqual(expect.arrayContaining([
      "failure-to-state-a-claim",
      "missing-element-support",
      "jurisdiction-or-venue-gap",
      "damages-or-relief-gap",
    ]));
    expect(result.mtdAttacks.every((attack) => attack.draftRiskOnly)).toBe(true);
    expect(result.mtdAttacks.find((attack) => attack.category === "missing-element-support")?.missingProofIds).toContain("MP-001");
    expect(result.mtdAttacks.find((attack) => attack.category === "jurisdiction-or-venue-gap")?.severity).toBe("blocker");
  });

  it("preserves source, receipt, authority, and citation IDs on citation issue rows", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, {
      manifest: complaintManifest({
        paragraphs: [{ paragraphId: "P-001", claimDraftId: "CD-001", sourcePaths: ["Vault/A.md"], receiptIds: ["R-001"], citationStatusIds: ["CIT-001"], authorityRecordIds: ["AUTH-001"] }],
        claimDrafts: [{ claimDraftId: "CD-001", elementIds: ["EL-001"], supportIds: ["SUP-001"], sourcePaths: ["Vault/A.md"], receiptIds: ["R-001"], citationStatusIds: ["CIT-001"], authorityRecordIds: ["AUTH-001"] }],
        sourceReferences: [
          { sourceReferenceId: "SRC-001", sourcePath: "Vault/A.md", receiptId: "R-001", authorityRecordId: "AUTH-001", citationStatusId: "CIT-001", authorityStatus: "ambiguous" },
          { sourceReferenceId: "SRC-002", receiptId: "R-002" },
        ],
        missingProof: [],
        counts: undefined,
      }),
    });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.citationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceReferenceIds: ["SRC-001"], sourcePaths: ["Vault/A.md"], receiptIds: ["R-001"], authorityRecordIds: ["AUTH-001"], citationStatusIds: ["CIT-001"] }),
      expect.objectContaining({ sourceReferenceIds: ["SRC-002"], receiptIds: ["R-002"] }),
    ]));
    expect(result.citationIssues.find((issue) => issue.summary.includes("CourtListener matched URL"))).toMatchObject({
      paragraphIds: ["P-001"],
      claimDraftIds: ["CD-001"],
      sourcePaths: ["Vault/A.md"],
      receiptIds: ["R-001"],
      authorityRecordIds: ["AUTH-001"],
      citationStatusIds: ["CIT-001"],
    });
  });

  it("flags claim drafts that have receipt IDs but no source-linked support", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, {
      manifest: complaintManifest({
        paragraphs: [],
        claimDrafts: [{ claimDraftId: "CD-NOSUPPORT", elementIds: ["EL-001"], supportIds: [], supportingEvidenceIds: [], sourcePaths: ["Vault/claim.md"], receiptIds: ["R-CLAIM"] }],
        sourceReferences: [{ sourceReferenceId: "SRC-CLAIM", sourcePath: "Vault/claim.md", receiptId: "R-CLAIM", courtListenerMatchedUrl: "https://www.courtlistener.com/opinion/1/example/" }],
        missingProof: [],
        counts: undefined,
      }),
    });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    expect(result.citationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimDraftIds: ["CD-NOSUPPORT"], sourcePaths: ["Vault/claim.md"], receiptIds: ["R-CLAIM"] }),
    ]));
    expect(result.mtdAttacks.map((attack) => attack.category)).toContain("missing-element-support");
  });

  it("creates revision recommendations that reference generated finding IDs", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, { manifest: complaintManifest() });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    const findingIds = new Set(result.findings.map((finding) => finding.findingId));
    expect(result.revisionRecommendations.length).toBe(result.findings.length);
    expect(result.revisionRecommendations.every((recommendation) => recommendation.findingIds.every((findingId) => findingIds.has(findingId)))).toBe(true);
    expect(result.revisionRecommendations.map((recommendation) => recommendation.summary).join(" ")).toContain("source-linked");
  });

  it("keeps findings deterministic across repeated collection", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, { manifest: complaintManifest({ counts: undefined }) });
    const first = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    const second = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1", now: () => new Date("2026-05-06T02:00:00.000Z") });
    expect(first.findings).toEqual(second.findings);
    expect(first.mtdAttacks).toEqual(second.mtdAttacks);
    expect(first.citationIssues).toEqual(second.citationIssues);
  });

  it("counts severe inherited blockers and redacts token-like strings in generated findings", async () => {
    const store = new FakeTaskStore();
    seedComplaint(store, {
      manifest: complaintManifest({ missingProof: [{ missingProofId: "MP-SECRET", reason: "Jurisdiction blocked by --auth-token top-secret-token-value" }] }),
      status: "blocked",
    });
    const result = await collectCounterLawsuitRedTeamInputs({ taskStore: store as never, runId: "CLW-1" });
    const serialized = JSON.stringify(result);
    expect(result.status).toBe("blocked");
    expect(result.counts.unresolvedBlockers).toBeGreaterThan(0);
    expect(result.findings.some((finding) => finding.severity === "blocker")).toBe(true);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("top-secret-token-value");
  });
});
