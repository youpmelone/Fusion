import type { Task, TaskDocument, TaskDocumentCreateInput, TaskDocumentRevision, WorkflowStep } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  LINEAGE_SCORING_LOG_DOCUMENT_KEY,
  LINEAGE_SCORING_LOG_SAFETY_NOTICE,
  LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
  collectCounterLawsuitLineageScoringLogInputs,
  deriveLineageScoringLogStatusForRun,
} from "../legal-lineage-scoring-log.js";

function makeTask(input: Partial<Task> & { id: string; stage?: string; documentKey?: string }): Task {
  return {
    id: input.id,
    title: input.title ?? `${input.stage ?? input.id} title`,
    description: input.description ?? `Prompt for ${input.stage ?? input.id} with lineage source citation reminders.`,
    priority: input.priority ?? "normal",
    column: input.column ?? "todo",
    dependencies: input.dependencies ?? [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: input.createdAt ?? "2026-05-06T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-06T00:00:00.000Z",
    sourceMetadata: {
      workflowKind: "counter-lawsuit-prototype",
      workflowRunId: "RUN-1",
      workflowStage: input.stage,
      documentKey: input.documentKey,
      ...(input.sourceMetadata ?? {}),
    },
  } as Task;
}

function makeDoc(input: Partial<TaskDocument> & { taskId: string; key: string; content?: string; metadata?: Record<string, unknown> }): TaskDocument {
  return {
    id: `${input.taskId}-${input.key}-doc`,
    taskId: input.taskId,
    key: input.key,
    content: input.content ?? `# ${input.key}\n\ncontent`,
    revision: input.revision ?? 1,
    author: input.author ?? "agent",
    metadata: input.metadata,
    createdAt: input.createdAt ?? "2026-05-06T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-06T00:00:00.000Z",
  };
}

function makeRevision(input: Partial<TaskDocumentRevision> & { taskId: string; key: string; revision: number; content?: string; metadata?: Record<string, unknown> }): TaskDocumentRevision {
  return {
    id: input.id ?? input.revision,
    taskId: input.taskId,
    key: input.key,
    content: input.content ?? `revision ${input.revision}`,
    revision: input.revision,
    author: input.author ?? "agent",
    metadata: input.metadata,
    createdAt: input.createdAt ?? `2026-05-06T00:00:0${input.revision}.000Z`,
  };
}

class FakeLineageStore {
  tasks: Task[] = [];
  documents = new Map<string, TaskDocument>();
  revisions = new Map<string, TaskDocumentRevision[]>();
  workflowSteps: WorkflowStep[] = [];
  upserts: Array<{ taskId: string; input: TaskDocumentCreateInput }> = [];

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async listWorkflowSteps(): Promise<WorkflowStep[]> {
    return this.workflowSteps;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  async getTaskDocuments(taskId: string): Promise<TaskDocument[]> {
    return [...this.documents.values()].filter((doc) => doc.taskId === taskId).sort((left, right) => left.key.localeCompare(right.key));
  }

  async getTaskDocumentRevisions(taskId: string, key: string): Promise<TaskDocumentRevision[]> {
    return this.revisions.get(`${taskId}:${key}`) ?? [];
  }

  async upsertTaskDocument(taskId: string, input: TaskDocumentCreateInput): Promise<TaskDocument> {
    this.upserts.push({ taskId, input });
    const doc = makeDoc({ taskId, key: input.key, content: input.content, metadata: input.metadata });
    this.documents.set(`${taskId}:${input.key}`, doc);
    return doc;
  }

  addDoc(doc: TaskDocument): void {
    this.documents.set(`${doc.taskId}:${doc.key}`, doc);
  }

  addRevision(revision: TaskDocumentRevision): void {
    const key = `${revision.taskId}:${revision.key}`;
    this.revisions.set(key, [...(this.revisions.get(key) ?? []), revision]);
  }
}

function seedStageTasks(store: FakeLineageStore): void {
  const stages = [
    ["T1", "research-memo", "research-memo"],
    ["T2", "evidence-ledger", "evidence-ledger"],
    ["T3", "claim-map", "claim-map"],
    ["T4", "draft-counter-lawsuit-complaint", "draft-counter-lawsuit-complaint"],
    ["T5", "opposing-counsel-red-team-report", "red-team-report"],
    ["T6", "lineage-scoring-log", LINEAGE_SCORING_LOG_DOCUMENT_KEY],
  ] as const;
  store.tasks = stages.map(([id, stage, key], index) => makeTask({ id, stage, documentKey: key, dependencies: index > 0 ? [`T${index}`] : [] }));
}

function seedRequiredArtifacts(store: FakeLineageStore): void {
  const manifests = [
    ["T1", "research-memo", { status: "completed", searches: [{ query: "retaliation elements", receiptIds: ["R-1"] }], evidence: [{ receiptId: "R-1", sourcePath: "vault/source.md", query: "retaliation elements" }] }],
    ["T2", "evidence-ledger", { status: "completed", sourceLinks: [{ receiptId: "R-1", sourcePath: "vault/source.md" }] }],
    ["T3", "claim-map", { status: "completed", claims: [{ claimId: "CL-1" }] }],
    ["T4", "draft-counter-lawsuit-complaint", { status: "completed", paragraphs: [{ paragraphId: "P-1" }] }],
    ["T5", "red-team-report", { status: "completed", findings: [{ findingId: "F-1", severity: "warning" }] }],
  ] as const;
  for (const [taskId, key, metadata] of manifests) {
    store.addDoc(makeDoc({ taskId, key, metadata, content: `# ${key}\n\nSafe content for ${key}.` }));
  }
}

function seedWorkflowStep(store: FakeLineageStore): void {
  store.workflowSteps = [{
    id: "WS-1",
    name: "Counter-lawsuit lineage preservation",
    description: "Requires lineage.",
    mode: "prompt",
    phase: "pre-merge",
    prompt: "Check lineage-scoring-log, source receipts, red-team blockers, and citation limitations before passing.",
    enabled: true,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
  }];
}

describe("legal lineage/scoring log service", () => {
  it("exports the canonical document keys and non-promotional safety notice", () => {
    expect(LINEAGE_SCORING_LOG_DOCUMENT_KEY).toBe("lineage-scoring-log");
    expect(LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY).toBe("lineage-scoring-log-status");
    expect(LINEAGE_SCORING_LOG_SAFETY_NOTICE).toContain("workflow diagnostics only");
    expect(LINEAGE_SCORING_LOG_SAFETY_NOTICE).toContain("not legal advice");
    expect(LINEAGE_SCORING_LOG_SAFETY_NOTICE).toContain("not reliability certification");
    expect(LINEAGE_SCORING_LOG_SAFETY_NOTICE).toContain("not filing-readiness review");
  });

  it("looks up workflow tasks by run metadata and orders stage traces deterministically", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    store.tasks.reverse();
    seedRequiredArtifacts(store);
    const result = await collectCounterLawsuitLineageScoringLogInputs({ taskStore: store, runId: "RUN-1", now: () => new Date("2026-05-06T01:00:00.000Z") });
    expect(result.stageTraces.map((trace) => trace.workflowStage)).toEqual([
      "research-memo",
      "evidence-ledger",
      "claim-map",
      "draft-counter-lawsuit-complaint",
      "opposing-counsel-red-team-report",
      "lineage-scoring-log",
    ]);
    expect(result.lineageTaskId).toBe("T6");
    expect(result.status).toBe("completed");
  });

  it("returns not-run for older workflow runs that do not have the lineage stage task", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    store.tasks = store.tasks.filter((task) => task.sourceMetadata?.workflowStage !== "lineage-scoring-log");
    seedRequiredArtifacts(store);
    const summary = await deriveLineageScoringLogStatusForRun({ taskStore: store, runId: "RUN-1" });
    expect(summary.status).toBe("not-run");
    expect(summary.lineageScoringLogDocumentKey).toBeUndefined();
  });

  it("parses manifests from metadata before considering JSON blocks", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.addDoc(makeDoc({
      taskId: "T6",
      key: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
      metadata: { status: "partial", counts: { promptTraces: 3 }, diagnostics: [{ code: "metadata-wins", severity: "warning", message: "metadata summary" }] },
      content: "```json\n{\"status\":\"completed\",\"counts\":{\"promptTraces\":99}}\n```",
    }));
    const summary = await deriveLineageScoringLogStatusForRun({ taskStore: store, runId: "RUN-1" });
    expect(summary.status).toBe("partial");
    expect(summary.promptTraceCount).toBe(3);
    expect(summary.diagnostics[0]?.code).toBe("metadata-wins");
  });

  it("falls back to a machine-readable JSON block when document metadata is absent", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.addDoc(makeDoc({
      taskId: "T6",
      key: LINEAGE_SCORING_LOG_DOCUMENT_KEY,
      content: "# log\n\n```json\n{\"status\":\"completed\",\"counts\":{\"searchTraces\":2,\"draftVersions\":4},\"promotionRationale\":{\"decision\":\"not-promoted\"}}\n```",
    }));
    const summary = await deriveLineageScoringLogStatusForRun({ taskStore: store, runId: "RUN-1" });
    expect(summary.status).toBe("completed");
    expect(summary.searchTraceCount).toBe(2);
    expect(summary.draftVersionCount).toBe(4);
  });

  it("surfaces malformed primary manifests as failed summaries instead of completed", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.addDoc(makeDoc({ taskId: "T6", key: LINEAGE_SCORING_LOG_DOCUMENT_KEY, content: "# no manifest here" }));
    const summary = await deriveLineageScoringLogStatusForRun({ taskStore: store, runId: "RUN-1" });
    expect(summary.status).toBe("failed");
    expect(summary.diagnostics).toEqual([expect.objectContaining({ code: "malformed-manifest" })]);
  });

  it("collects current documents, revisions, content hashes, and bounded redacted excerpts", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.addDoc(makeDoc({
      taskId: "T4",
      key: "counter-lawsuit-stage",
      metadata: { status: "completed" },
      content: `Draft prompt with --auth-token super-secret-token-value and ${"x".repeat(900)}`,
    }));
    store.addRevision(makeRevision({ taskId: "T4", key: "draft-counter-lawsuit-complaint", revision: 1, content: "prior complaint draft", metadata: { status: "partial" } }));
    const result = await collectCounterLawsuitLineageScoringLogInputs({ taskStore: store, runId: "RUN-1" });
    const source = result.sourceDocuments.find((trace) => trace.taskId === "T4" && trace.documentKey === "counter-lawsuit-stage");
    expect(source?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(source?.excerpt).toContain("--auth-token [REDACTED]");
    expect(source?.excerpt?.length).toBeLessThanOrEqual(700);
    expect(source?.excerpt).toContain("…");
    expect(result.draftVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "T4", documentKey: "draft-counter-lawsuit-complaint", current: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ taskId: "T4", documentKey: "draft-counter-lawsuit-complaint", current: false, revision: 1 }),
    ]));
    expect(result.rejectedVariants).toEqual([expect.objectContaining({ sourceTaskId: "T4", sourceDocumentKey: "draft-counter-lawsuit-complaint", preserved: true })]);
  });

  it("captures workflow-step prompt traces and search traces without accepting request-provided lineage", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    seedWorkflowStep(store);
    const result = await collectCounterLawsuitLineageScoringLogInputs({ taskStore: store, runId: "RUN-1" });
    expect(result.promptTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "workflow-step", workflowStepId: "WS-1", safetyGateRefs: expect.arrayContaining(["lineage-preservation"]) }),
    ]));
    expect(result.searchTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceTaskId: "T1", query: "retaliation elements", receiptIds: ["R-1"] }),
      expect.objectContaining({ sourceTaskId: "T1", sourcePath: "vault/source.md", receiptIds: ["R-1"] }),
    ]));
  });

  it("uses status documents ahead of stale primary logs", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.addDoc(makeDoc({ taskId: "T6", key: LINEAGE_SCORING_LOG_DOCUMENT_KEY, metadata: { status: "completed", counts: { promptTraces: 5 } } }));
    store.addDoc(makeDoc({
      taskId: "T6",
      key: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
      metadata: { status: "blocked", counts: { promptTraces: 1, unresolvedBlockers: 2 }, diagnostics: [{ code: "status-blocker", severity: "error", message: "blocked by upstream" }] },
    }));
    const summary = await deriveLineageScoringLogStatusForRun({ taskStore: store, runId: "RUN-1" });
    expect(summary.status).toBe("blocked");
    expect(summary.promptTraceCount).toBe(1);
    expect(summary.unresolvedBlockerCount).toBe(2);
    expect(summary.statusDocumentKey).toBe(LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY);
  });

  it("never treats a completed status document as completed when the primary log is missing", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.addDoc(makeDoc({
      taskId: "T6",
      key: LINEAGE_SCORING_LOG_STATUS_DOCUMENT_KEY,
      metadata: { status: "completed", counts: { promptTraces: 8 } },
    }));
    const summary = await deriveLineageScoringLogStatusForRun({ taskStore: store, runId: "RUN-1" });
    expect(summary.status).toBe("failed");
    expect(summary.lineageScoringLogDocumentKey).toBeUndefined();
    expect(summary.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-primary-lineage-log" })]));
  });

  it("turns missing upstream manifests into blocked collection diagnostics", async () => {
    const store = new FakeLineageStore();
    seedStageTasks(store);
    seedRequiredArtifacts(store);
    store.documents.delete("T5:red-team-report");
    const result = await collectCounterLawsuitLineageScoringLogInputs({ taskStore: store, runId: "RUN-1" });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-upstream-artifact", sourceDocumentKey: "red-team-report" })]));
  });
});
