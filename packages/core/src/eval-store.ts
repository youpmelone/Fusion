import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJson, toJsonNullable } from "./db.js";
import type {
  EvalRun,
  EvalRunCreateInput,
  EvalRunEvent,
  EvalRunListOptions,
  EvalRunStatus,
  EvalRunUpdateInput,
  EvalStoreEvents,
  EvalTaskResult,
  EvalTaskResultCreateInput,
  EvalTaskResultListOptions,
  EvalTaskResultUpdateInput,
} from "./eval-types.js";

const TERMINAL_STATUSES = new Set<EvalRunStatus>(["completed", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set<EvalRunStatus>(["pending", "running"]);
const VALID_TRANSITIONS: Record<EvalRunStatus, EvalRunStatus[]> = {
  pending: ["running", "completed", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class EvalLifecycleError extends Error {
  constructor(message: string, readonly code: "invalid_transition" | "terminal_immutable" | "active_run_conflict") {
    super(message);
    this.name = "EvalLifecycleError";
  }
}

function generateRunId(): string {
  return `ER-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function generateResultId(): string {
  return `ETR-${randomUUID()}`;
}

function generateEventId(): string {
  return `ERE-${randomUUID()}`;
}

export class EvalStore extends EventEmitter<EvalStoreEvents> {
  constructor(private readonly db: Database) {
    super();
    this.setMaxListeners(50);
  }

  createRun(input: EvalRunCreateInput): EvalRun {
    const now = new Date().toISOString();
    if ((input.trigger === "schedule" || input.trigger === "task_completion") && this.hasActiveRun(input.projectId, input.trigger)) {
      throw new EvalLifecycleError(`Active eval run already exists for project ${input.projectId} trigger ${input.trigger}`, "active_run_conflict");
    }

    const run: EvalRun = {
      id: generateRunId(),
      projectId: input.projectId,
      status: "pending",
      trigger: input.trigger ?? "manual",
      scope: input.scope,
      window: input.window ?? {},
      requestedTaskIds: input.requestedTaskIds ?? [],
      evaluatedTaskIds: [],
      counts: { totalTasks: input.requestedTaskIds?.length ?? 0, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 },
      provenance: input.provenance,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO eval_runs (
        id, projectId, status, trigger, scope, window, requestedTaskIds, evaluatedTaskIds,
        counts, aggregateScores, summary, error, provenance, metadata,
        createdAt, updatedAt, startedAt, completedAt, cancelledAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.projectId,
      run.status,
      run.trigger,
      run.scope,
      toJson(run.window),
      toJson(run.requestedTaskIds),
      toJson(run.evaluatedTaskIds),
      toJson(run.counts),
      null,
      null,
      null,
      toJsonNullable(run.provenance),
      toJsonNullable(run.metadata),
      run.createdAt,
      run.updatedAt,
      null,
      null,
      null,
    );

    this.db.bumpLastModified();
    this.emit("run:created", run);
    return run;
  }

  getRun(id: string): EvalRun | undefined {
    const row = this.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  listRuns(options: EvalRunListOptions = {}): EvalRun[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.projectId) {
      clauses.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.trigger) {
      clauses.push("trigger = ?");
      params.push(options.trigger);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
    const offset = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

    const rows = this.db.prepare(`
      SELECT * FROM eval_runs
      ${where}
      ORDER BY createdAt ASC, id ASC
      ${limit}
      ${offset}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRun(row));
  }

  updateRun(id: string, input: EvalRunUpdateInput): EvalRun | undefined {
    const existing = this.getRun(id);
    if (!existing) return undefined;

    if (TERMINAL_STATUSES.has(existing.status) && Object.keys(input).some((k) => k !== "status")) {
      throw new EvalLifecycleError(`Eval run ${id} is terminal and immutable`, "terminal_immutable");
    }

    if (input.status && input.status !== existing.status) {
      if (!VALID_TRANSITIONS[existing.status].includes(input.status)) {
        throw new EvalLifecycleError(`Invalid eval run status transition: ${existing.status} -> ${input.status}`, "invalid_transition");
      }
    }

    const now = new Date().toISOString();
    const updated: EvalRun = {
      ...existing,
      ...input,
      error: input.error === null ? undefined : (input.error ?? existing.error),
      metadata: input.metadata ? { ...(existing.metadata ?? {}), ...input.metadata } : existing.metadata,
      provenance: input.provenance ? { ...(existing.provenance ?? {}), ...input.provenance } : existing.provenance,
      updatedAt: now,
      startedAt: input.startedAt === null ? undefined : (input.startedAt ?? existing.startedAt),
      completedAt: input.completedAt === null ? undefined : (input.completedAt ?? existing.completedAt),
      cancelledAt: input.cancelledAt === null ? undefined : (input.cancelledAt ?? existing.cancelledAt),
    };

    this.persistRun(updated);
    this.emit("run:updated", updated);
    return updated;
  }

  deleteRun(id: string): boolean {
    const result = this.db.prepare("DELETE FROM eval_runs WHERE id = ?").run(id) as { changes?: number };
    const deleted = (result.changes ?? 0) > 0;
    if (deleted) {
      this.db.bumpLastModified();
      this.emit("run:deleted", id);
    }
    return deleted;
  }

  createTaskResult(runId: string, input: EvalTaskResultCreateInput): EvalTaskResult {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Eval run not found: ${runId}`);

    const now = new Date().toISOString();
    const result: EvalTaskResult = {
      id: generateResultId(),
      runId,
      taskId: input.taskId,
      taskSnapshot: input.taskSnapshot,
      status: input.status,
      overallScore: input.overallScore,
      maxScore: input.maxScore,
      categoryScores: input.categoryScores ?? [],
      rationale: input.rationale,
      summary: input.summary,
      evidence: input.evidence ?? [],
      deterministicSignals: input.deterministicSignals ?? [],
      aiSignals: input.aiSignals,
      followUps: input.followUps ?? [],
      provenance: input.provenance,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO eval_task_results (
        id, runId, taskId, taskSnapshot, status, overallScore, maxScore,
        categoryScores, rationale, summary, evidence, deterministicSignals, aiSignals,
        followUps, provenance, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      result.runId,
      result.taskId,
      toJson(result.taskSnapshot),
      result.status,
      result.overallScore ?? null,
      result.maxScore ?? null,
      toJson(result.categoryScores),
      result.rationale ?? null,
      result.summary ?? null,
      toJson(result.evidence),
      toJson(result.deterministicSignals),
      toJsonNullable(result.aiSignals),
      toJson(result.followUps),
      toJsonNullable(result.provenance),
      toJsonNullable(result.metadata),
      result.createdAt,
      result.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("result:created", result);
    return result;
  }

  getTaskResult(id: string): EvalTaskResult | undefined {
    const row = this.db.prepare("SELECT * FROM eval_task_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToResult(row) : undefined;
  }

  listTaskResults(options: EvalTaskResultListOptions = {}): EvalTaskResult[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.runId) {
      clauses.push("runId = ?");
      params.push(options.runId);
    }
    if (options.taskId) {
      clauses.push("taskId = ?");
      params.push(options.taskId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
    const offset = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

    const rows = this.db.prepare(`
      SELECT * FROM eval_task_results
      ${where}
      ORDER BY createdAt ASC, id ASC
      ${limit}
      ${offset}
    `).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToResult(row));
  }

  updateTaskResult(id: string, input: EvalTaskResultUpdateInput): EvalTaskResult | undefined {
    const existing = this.getTaskResult(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const updated: EvalTaskResult = {
      ...existing,
      ...input,
      metadata: input.metadata ? { ...(existing.metadata ?? {}), ...input.metadata } : existing.metadata,
      provenance: input.provenance ? { ...(existing.provenance ?? {}), ...input.provenance } : existing.provenance,
      updatedAt: now,
    };

    this.db.prepare(`
      UPDATE eval_task_results SET
        status = ?, overallScore = ?, maxScore = ?, categoryScores = ?, rationale = ?, summary = ?,
        evidence = ?, deterministicSignals = ?, aiSignals = ?, followUps = ?, provenance = ?, metadata = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      updated.status,
      updated.overallScore ?? null,
      updated.maxScore ?? null,
      toJson(updated.categoryScores),
      updated.rationale ?? null,
      updated.summary ?? null,
      toJson(updated.evidence),
      toJson(updated.deterministicSignals),
      toJsonNullable(updated.aiSignals),
      toJson(updated.followUps),
      toJsonNullable(updated.provenance),
      toJsonNullable(updated.metadata),
      updated.updatedAt,
      id,
    );

    this.db.bumpLastModified();
    this.emit("result:updated", updated);
    return updated;
  }

  appendRunEvent(runId: string, event: Omit<EvalRunEvent, "id" | "runId" | "seq" | "createdAt">): EvalRunEvent {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Eval run not found: ${runId}`);

    const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) as maxSeq FROM eval_run_events WHERE runId = ?").get(runId) as { maxSeq: number };
    const created: EvalRunEvent = {
      id: generateEventId(),
      runId,
      seq: (maxSeq?.maxSeq ?? 0) + 1,
      type: event.type,
      message: event.message,
      status: event.status,
      taskId: event.taskId,
      metadata: event.metadata,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO eval_run_events (id, runId, seq, type, message, status, taskId, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id,
      created.runId,
      created.seq,
      created.type,
      created.message,
      created.status ?? null,
      created.taskId ?? null,
      toJsonNullable(created.metadata),
      created.createdAt,
    );

    this.db.bumpLastModified();
    this.emit("run:event", { runId, event: created });
    return created;
  }

  listRunEvents(runId: string): EvalRunEvent[] {
    const rows = this.db.prepare("SELECT * FROM eval_run_events WHERE runId = ? ORDER BY seq ASC, id ASC").all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEvent(row));
  }

  private hasActiveRun(projectId: string, trigger: string): boolean {
    const placeholders = Array.from(ACTIVE_STATUSES).map(() => "?").join(", ");
    const row = this.db.prepare(`SELECT id FROM eval_runs WHERE projectId = ? AND trigger = ? AND status IN (${placeholders}) LIMIT 1`)
      .get(projectId, trigger, ...Array.from(ACTIVE_STATUSES)) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  private persistRun(run: EvalRun): void {
    this.db.prepare(`
      UPDATE eval_runs SET
        status = ?, scope = ?, window = ?, requestedTaskIds = ?, evaluatedTaskIds = ?, counts = ?, aggregateScores = ?,
        summary = ?, error = ?, provenance = ?, metadata = ?, updatedAt = ?, startedAt = ?, completedAt = ?, cancelledAt = ?
      WHERE id = ?
    `).run(
      run.status,
      run.scope,
      toJson(run.window),
      toJson(run.requestedTaskIds),
      toJson(run.evaluatedTaskIds),
      toJson(run.counts),
      toJsonNullable(run.aggregateScores),
      run.summary ?? null,
      run.error ?? null,
      toJsonNullable(run.provenance),
      toJsonNullable(run.metadata),
      run.updatedAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
      run.cancelledAt ?? null,
      run.id,
    );
    this.db.bumpLastModified();
  }

  private rowToRun(row: Record<string, unknown>): EvalRun {
    return {
      id: String(row.id),
      projectId: String(row.projectId),
      status: row.status as EvalRunStatus,
      trigger: row.trigger as EvalRun["trigger"],
      scope: String(row.scope),
      window: fromJson(row.window as string) ?? {},
      requestedTaskIds: fromJson<string[]>(row.requestedTaskIds as string) ?? [],
      evaluatedTaskIds: fromJson<string[]>(row.evaluatedTaskIds as string) ?? [],
      counts: fromJson(row.counts as string) ?? { totalTasks: 0, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 },
      aggregateScores: fromJson<Record<string, number>>(row.aggregateScores as string),
      summary: (row.summary as string | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      provenance: fromJson(row.provenance as string),
      metadata: fromJson(row.metadata as string),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      startedAt: (row.startedAt as string | null) ?? undefined,
      completedAt: (row.completedAt as string | null) ?? undefined,
      cancelledAt: (row.cancelledAt as string | null) ?? undefined,
    };
  }

  private rowToResult(row: Record<string, unknown>): EvalTaskResult {
    return {
      id: String(row.id),
      runId: String(row.runId),
      taskId: String(row.taskId),
      taskSnapshot: fromJson(row.taskSnapshot as string) ?? { taskId: String(row.taskId) },
      status: row.status as EvalTaskResult["status"],
      overallScore: row.overallScore == null ? undefined : Number(row.overallScore),
      maxScore: row.maxScore == null ? undefined : Number(row.maxScore),
      categoryScores: fromJson(row.categoryScores as string) ?? [],
      rationale: (row.rationale as string | null) ?? undefined,
      summary: (row.summary as string | null) ?? undefined,
      evidence: fromJson(row.evidence as string) ?? [],
      deterministicSignals: fromJson(row.deterministicSignals as string) ?? [],
      aiSignals: fromJson(row.aiSignals as string),
      followUps: fromJson(row.followUps as string) ?? [],
      provenance: fromJson(row.provenance as string),
      metadata: fromJson(row.metadata as string),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  private rowToEvent(row: Record<string, unknown>): EvalRunEvent {
    return {
      id: String(row.id),
      runId: String(row.runId),
      seq: Number(row.seq),
      type: row.type as EvalRunEvent["type"],
      message: String(row.message),
      status: (row.status as EvalRunStatus | null) ?? undefined,
      taskId: (row.taskId as string | null) ?? undefined,
      metadata: fromJson(row.metadata as string),
      createdAt: String(row.createdAt),
    };
  }
}
