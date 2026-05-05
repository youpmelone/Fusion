import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db.js";
import { EvalLifecycleError, EvalStore } from "../eval-store.js";

let db: Database;
let store: EvalStore;

beforeEach(() => {
  db = createDatabase("/tmp/fn-eval-store-test", { inMemory: true });
  db.init();
  store = new EvalStore(db);
});

describe("EvalStore", () => {
  it("creates and lists runs with deterministic ordering", () => {
    const runA = store.createRun({ projectId: "p1", scope: "completed-since-last", requestedTaskIds: ["FN-1"] });
    const runB = store.createRun({ projectId: "p1", scope: "completed-since-last", requestedTaskIds: ["FN-2"] });

    const runs = store.listRuns({ projectId: "p1" });
    expect(runs.map((run) => run.id)).toEqual([runA.id, runB.id].sort());
  });

  it("enforces active run conflict for scheduled trigger", () => {
    store.createRun({ projectId: "p1", scope: "window", trigger: "schedule" });
    expect(() => store.createRun({ projectId: "p1", scope: "window", trigger: "schedule" })).toThrow(EvalLifecycleError);
  });

  it("enforces terminal immutability", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    store.updateRun(run.id, { status: "completed" });
    expect(() => store.updateRun(run.id, { summary: "late change" })).toThrow(EvalLifecycleError);
  });

  it("creates results and preserves task snapshot after tasks row deletion", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    const result = store.createTaskResult(run.id, {
      taskId: "FN-123",
      taskSnapshot: { taskId: "FN-123", title: "Snapshot title", status: "done", summary: "task summary" },
      status: "scored",
      overallScore: 0.8,
      categoryScores: [{ category: "quality", score: 0.8 }],
      evidence: [{ type: "task_log", ref: "log:1" }],
      deterministicSignals: [{ signalId: "s1", kind: "test", name: "tests-pass", passed: true }],
    });

    db.prepare("DELETE FROM tasks WHERE id = ?").run("FN-123");

    const fetched = store.getTaskResult(result.id);
    expect(fetched?.taskSnapshot.title).toBe("Snapshot title");
    expect(fetched?.taskId).toBe("FN-123");
  });

  it("persists run window boundaries and evaluated task rollups", () => {
    const run = store.createRun({
      projectId: "p1",
      trigger: "schedule",
      scope: "completed-since-last",
      window: { since: "2026-05-01T00:00:00.000Z", until: "2026-05-02T00:00:00.000Z", baselineRunId: "ER-BASE" },
      requestedTaskIds: ["FN-1", "FN-2"],
    });

    const updated = store.updateRun(run.id, {
      status: "running",
      evaluatedTaskIds: ["FN-1", "FN-2"],
      counts: { totalTasks: 2, scoredTasks: 1, skippedTasks: 1, erroredTasks: 0 },
    });

    expect(updated?.window.since).toBe("2026-05-01T00:00:00.000Z");
    expect(updated?.evaluatedTaskIds).toEqual(["FN-1", "FN-2"]);
    expect(updated?.counts.scoredTasks).toBe(1);
  });

  it("appends run events with sequential ordering", () => {
    const run = store.createRun({ projectId: "p1", scope: "window" });
    const evt1 = store.appendRunEvent(run.id, { type: "info", message: "started" });
    const evt2 = store.appendRunEvent(run.id, { type: "task_evaluated", message: "scored", taskId: "FN-1" });

    const events = store.listRunEvents(run.id);
    expect(events.map((event) => event.id)).toEqual([evt1.id, evt2.id]);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });
});
