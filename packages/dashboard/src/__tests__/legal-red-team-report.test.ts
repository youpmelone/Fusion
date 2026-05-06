import { describe, expect, it } from "vitest";
import type { Task, TaskDocument } from "@fusion/core";
import { CLAIM_MAP_DOCUMENT_KEY } from "../legal-claim-map.js";
import {
  RED_TEAM_REPORT_DOCUMENT_KEY,
  RED_TEAM_REPORT_SAFETY_NOTICE,
  RED_TEAM_REPORT_STATUS_DOCUMENT_KEY,
  collectCounterLawsuitRedTeamInputs,
  deriveRedTeamReportStatusForRun,
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

  it("exports the draft-only adversarial safety notice", () => {
    expect(RED_TEAM_REPORT_SAFETY_NOTICE).toContain("Draft-only");
    expect(RED_TEAM_REPORT_SAFETY_NOTICE).toContain("not legal advice");
    expect(RED_TEAM_REPORT_SAFETY_NOTICE).toContain("not filing-ready");
  });
});
