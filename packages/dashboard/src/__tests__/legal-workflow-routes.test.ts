import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { describe, expect, it } from "vitest";
import { AgentStore, TaskStore } from "@fusion/core";
import type { Agent, Task, WorkflowStep } from "@fusion/core";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerLegalWorkflowRoutes } from "../routes/register-legal-workflow-routes.js";
import type { ApiRoutesContext } from "../routes/types.js";
import { request } from "../test-request.js";

const safeguards = {
  citationSourceVerification: true,
  opposingCounselRedTeam: true,
  preserveLineage: true,
  humanVerificationRequired: true,
} as const;

function makeTask(input: Partial<Task> & { id: string; description: string }): Task {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "normal",
    column: input.column ?? "todo",
    dependencies: input.dependencies ?? [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
    enabledWorkflowSteps: input.enabledWorkflowSteps,
    assignedAgentId: input.assignedAgentId,
    reviewLevel: input.reviewLevel,
    sourceType: input.sourceType,
    sourceRunId: input.sourceRunId,
    sourceMetadata: input.sourceMetadata,
    status: input.status,
    error: input.error,
  };
}

class FakeTaskStore {
  tasks: Task[] = [];
  workflowSteps: WorkflowStep[] = [];
  documents: Array<{ taskId: string; key: string; content: string; metadata?: Record<string, unknown> }> = [];

  constructor(readonly label: string) {}

  getRootDir(): string {
    return `.fusion/${this.label}`;
  }

  async createTask(input: any): Promise<Task> {
    const id = `${this.label.toUpperCase()}-${String(this.tasks.length + 1).padStart(3, "0")}`;
    const task = makeTask({
      id,
      title: input.title,
      description: input.description,
      column: input.column,
      dependencies: input.dependencies,
      enabledWorkflowSteps: input.enabledWorkflowSteps,
      assignedAgentId: input.assignedAgentId,
      reviewLevel: input.reviewLevel,
      priority: input.priority,
      sourceType: input.source?.sourceType,
      sourceRunId: input.source?.sourceRunId,
      sourceMetadata: input.source?.sourceMetadata,
    });
    this.tasks.push(task);
    return task;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; metadata?: Record<string, unknown> }) {
    this.documents.push({ taskId, ...input });
    return { id: `${taskId}:${input.key}`, taskId, key: input.key, content: input.content, author: "fusion", metadata: input.metadata ?? {}, createdAt: "now", updatedAt: "now" };
  }

  async listWorkflowSteps(): Promise<WorkflowStep[]> {
    return this.workflowSteps;
  }

  async createWorkflowStep(input: any): Promise<WorkflowStep> {
    const step = {
      id: `${this.label.toUpperCase()}-WS-${String(this.workflowSteps.length + 1).padStart(3, "0")}`,
      templateId: input.templateId,
      name: input.name,
      description: input.description,
      mode: input.mode ?? "prompt",
      phase: input.phase ?? "pre-merge",
      prompt: input.prompt,
      toolMode: input.toolMode,
      enabled: input.enabled ?? true,
      defaultOn: input.defaultOn,
      createdAt: "now",
      updatedAt: "now",
    } as WorkflowStep;
    this.workflowSteps.push(step);
    return step;
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }
}

class FakeAgentStore {
  agents: Agent[] = [];

  async listAgents(): Promise<Agent[]> {
    return this.agents;
  }

  async createAgent(input: any): Promise<Agent> {
    const agent: Agent = {
      id: `agent-${String(this.agents.length + 1).padStart(3, "0")}`,
      name: input.name,
      role: input.role,
      state: "idle",
      createdAt: "now",
      updatedAt: "now",
      metadata: input.metadata ?? {},
      title: input.title,
    };
    this.agents.push(agent);
    return agent;
  }

  async updateAgent(agentId: string, updates: any): Promise<Agent> {
    const index = this.agents.findIndex((agent) => agent.id === agentId);
    if (index === -1) throw new Error("agent not found");
    this.agents[index] = { ...this.agents[index], ...updates, updatedAt: "later" };
    return this.agents[index];
  }
}

function buildApp() {
  const defaultStore = new FakeTaskStore("default");
  const projectStore = new FakeTaskStore("project");
  const agentStores = new Map<FakeTaskStore, FakeAgentStore>();
  agentStores.set(defaultStore, new FakeAgentStore());
  agentStores.set(projectStore, new FakeAgentStore());

  const app = express();
  app.use(express.json());
  const router = express.Router();
  const ctx = {
    router,
    store: defaultStore,
    getProjectContext: async (req: express.Request) => {
      const store = req.query.projectId === "project-1" ? projectStore : defaultStore;
      return { store, engine: undefined, projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined };
    },
    rethrowAsApiError(error: unknown): never {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : String(error));
    },
  } as unknown as ApiRoutesContext;

  registerLegalWorkflowRoutes(ctx, {
    createAgentStore: (store) => agentStores.get(store as FakeTaskStore)!,
  });
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      return;
    }
    sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
  });

  return { app, defaultStore, projectStore, defaultAgentStore: agentStores.get(defaultStore)!, projectAgentStore: agentStores.get(projectStore)! };
}

function launchBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    matterName: "Acme response matter",
    focus: "Retaliatory filing timeline",
    vaultScope: "client/acme/litigation",
    requestedArtifacts: ["research-memo"],
    safeguards,
    ...overrides,
  });
}

describe("legal workflow routes", () => {
  it("POST queues a legal workflow run with FN-001-compatible and expanded response fields", async () => {
    const { app, defaultStore, defaultAgentStore } = buildApp();

    const response = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody({ codexSkillNames: ["legal-research", "legal-drafting"] }), { "Content-Type": "application/json" });

    expect(response.status).toBe(201);
    const body = response.body as any;
    expect(body.runId).toMatch(/^CLW-/);
    expect(body.status).toBe("queued");
    expect(body.taskId).toBe("DEFAULT-001");
    expect(body.task.id).toBe("DEFAULT-001");
    expect(body.artifacts).toHaveLength(6);
    expect(body.stageTasks).toHaveLength(6);
    expect(body.workflowStepIds).toHaveLength(3);
    expect(body.agentIds).toHaveLength(6);
    expect(body.artifactKeys).toEqual(["research-memo", "evidence-ledger", "claim-map", "draft-counter-lawsuit-complaint", "red-team-report", "lineage-scoring-log"]);
    expect(body.safetyGates).toEqual(["citation-source-verification", "opposing-counsel-red-team", "lineage-preservation"]);
    expect(body.sourceScopeStatus).toBe("specified");
    expect(body.codexSkillSource).toBe("user");

    expect(defaultStore.tasks).toHaveLength(6);
    expect(defaultStore.tasks.every((task) => task.column === "todo")).toBe(true);
    expect(defaultStore.tasks.every((task) => Boolean(task.assignedAgentId))).toBe(true);
    expect(defaultStore.tasks[0].sourceType).toBe("dashboard_ui");
    expect(defaultStore.tasks[0].sourceMetadata?.workflowRunId).toBe(body.runId);
    expect(defaultAgentStore.agents.every((agent) => JSON.stringify(agent.metadata.skills) === JSON.stringify(["legal-research", "legal-drafting"]))).toBe(true);
  });

  it("returns 400 for invalid launch payloads", async () => {
    const { app } = buildApp();

    const response = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", JSON.stringify({ matterName: "Acme", safeguards: { ...safeguards, preserveLineage: false } }), { "Content-Type": "application/json" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "safeguards.preserveLineage must be true" });
  });

  it("accepts optional source scope omission, records unspecified source status, and defaults skills", async () => {
    const { app, defaultStore } = buildApp();

    const response = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody({ vaultScope: undefined, focus: "theory focus only" }), { "Content-Type": "application/json" });

    expect(response.status).toBe(201);
    const body = response.body as any;
    expect(body.sourceScopeStatus).toBe("unspecified");
    expect(body.codexSkillSource).toBe("default");
    expect(body.codexSkillNames).toEqual(["legal-research", "legal-evidence-mining", "legal-drafting", "opposing-counsel-red-team"]);
    expect(defaultStore.tasks[0].description).toContain("Treat all source discovery as unverified");
  });

  it("GET derives status and artifact states from tasks with matching run provenance", async () => {
    const { app, defaultStore } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;
    defaultStore.tasks[0] = { ...defaultStore.tasks[0], column: "done" };
    defaultStore.tasks[1] = { ...defaultStore.tasks[1], column: "in-progress" };

    const response = await request(app, "GET", `/api/legal-workflows/counter-lawsuit/runs/${runId}`);

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.runId).toBe(runId);
    expect(body.status).toBe("running");
    expect(body.stageTasks).toHaveLength(6);
    expect(body.artifacts[0]).toMatchObject({ id: "research-memo", status: "ready", taskId: "DEFAULT-001" });
    expect(body.artifacts[1]).toMatchObject({ id: "evidence-ledger", status: "generating", taskId: "DEFAULT-002" });
    expect(body.lineageDocuments[0]).toEqual({ taskId: "DEFAULT-001", documentKey: "counter-lawsuit-run", stage: "research-memo" });
  });

  it("GET returns 404 for unknown run IDs", async () => {
    const { app } = buildApp();

    const response = await request(app, "GET", "/api/legal-workflows/counter-lawsuit/runs/CLW-missing");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Legal workflow run CLW-missing not found" });
  });

  it("uses the project-scoped task and agent stores", async () => {
    const { app, defaultStore, projectStore, defaultAgentStore, projectAgentStore } = buildApp();

    const response = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs?projectId=project-1", launchBody(), { "Content-Type": "application/json" });

    expect(response.status).toBe(201);
    expect(defaultStore.tasks).toHaveLength(0);
    expect(defaultAgentStore.agents).toHaveLength(0);
    expect(projectStore.tasks).toHaveLength(6);
    expect(projectAgentStore.agents).toHaveLength(6);
    expect((response.body as any).taskId).toBe("PROJECT-001");
  });

  it("default agent-store wiring writes durable agents into the scoped store .fusion directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-legal-route-"));
    try {
      const store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
      await store.init();
      const app = express();
      app.use(express.json());
      const router = express.Router();
      const ctx = {
        router,
        store,
        getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
        rethrowAsApiError(error: unknown): never {
          if (error instanceof ApiError) throw error;
          throw new ApiError(500, error instanceof Error ? error.message : String(error));
        },
      } as unknown as ApiRoutesContext;
      registerLegalWorkflowRoutes(ctx);
      app.use("/api", router);
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        if (err instanceof ApiError) {
          sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
          return;
        }
        sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
      });

      const response = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });

      expect(response.status).toBe(201);
      const agentStore = new AgentStore({ rootDir: store.getFusionDir(), taskStore: store });
      await agentStore.init();
      const agents = await agentStore.listAgents({ includeEphemeral: false });
      expect(agents).toHaveLength(6);
      expect(agents.every((agent) => Array.isArray(agent.metadata.skills))).toBe(true);
      expect(new Set(agents.map((agent) => agent.id))).toEqual(new Set((response.body as any).agentIds));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
