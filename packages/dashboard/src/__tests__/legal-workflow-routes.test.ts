import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { describe, expect, it } from "vitest";
import { AgentStore, TaskStore } from "@fusion/core";
import type { Agent, ResearchRun, Task, TaskDocument, WorkflowStep } from "@fusion/core";
import type { LegalMcpClient, LegalMcpTool } from "../legal-mcp-client.js";
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

class FakeResearchStore {
  runs: ResearchRun[] = [];

  createRun(input: any): ResearchRun {
    const run = {
      id: `RR-${this.runs.length + 1}`,
      query: input.query,
      topic: input.topic,
      status: "queued",
      trigger: input.trigger,
      sources: input.sources ?? [],
      events: [],
      tags: input.tags ?? [],
      metadata: input.metadata,
      lifecycle: input.lifecycle,
      createdAt: "now",
      updatedAt: "now",
    } as ResearchRun;
    this.runs.push(run);
    return run;
  }

  updateStatus(id: string, status: ResearchRun["status"], extra?: Partial<ResearchRun>): void {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error("missing research run");
    Object.assign(run, extra ?? {}, { status });
  }
}

class FakeTaskStore {
  tasks: Task[] = [];
  workflowSteps: WorkflowStep[] = [];
  documents: Array<TaskDocument> = [];
  researchStore = new FakeResearchStore();

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

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; metadata?: Record<string, unknown>; author?: string }) {
    const document = { id: `${taskId}:${input.key}`, taskId, key: input.key, content: input.content, revision: 1, author: input.author ?? "fusion", metadata: input.metadata ?? {}, createdAt: "now", updatedAt: "now" } as TaskDocument;
    const index = this.documents.findIndex((candidate) => candidate.taskId === taskId && candidate.key === input.key);
    if (index >= 0) this.documents[index] = document;
    else this.documents.push(document);
    return document;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.find((document) => document.taskId === taskId && document.key === key) ?? null;
  }

  getResearchStore(): FakeResearchStore {
    return this.researchStore;
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

class FakeRouteMcpClient implements LegalMcpClient {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  closed = false;

  constructor(readonly serverName: string, private readonly tools: LegalMcpTool[], private readonly result: unknown) {}

  async listTools(): Promise<LegalMcpTool[]> {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, input });
    return this.result;
  }

  async close(): Promise<void> {
    this.closed = true;
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

function buildApp(routeDeps: Partial<Parameters<typeof registerLegalWorkflowRoutes>[1]> = {}) {
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
    ...routeDeps,
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
    expect(body.vaultMining).toMatchObject({ runId: body.runId, receiptsDocumentKey: "vault-mining-receipts" });
  });

  it("POST launch automatically runs bounded vault mining and returns the summary", async () => {
    const qmdClient = new FakeRouteMcpClient("qmd-mcp", [{ name: "search" }], [{ path: "vault/qmd.md", excerpt: "qmd" }]);
    const obsidianClient = new FakeRouteMcpClient("obsidian-vault", [{ name: "obsidian.search" }], [{ path: "vault/obsidian.md", excerpt: "obsidian" }]);
    const { app, defaultStore } = buildApp({
      mcpClientFactory: async ({ provider }) => provider === "qmd"
        ? { client: qmdClient, mcpServerName: "qmd-mcp" }
        : { client: obsidianClient, mcpServerName: "obsidian-vault" },
    });

    const response = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });

    expect(response.status).toBe(201);
    const body = response.body as any;
    expect(body.vaultMining).toMatchObject({ status: "completed", receiptCount: 6, researchRunId: "RR-1" });
    expect(defaultStore.documents.some((document) => document.key === "vault-mining-receipts" && document.content.includes("vault/qmd.md"))).toBe(true);
    expect(defaultStore.researchStore.runs[0].sources.map((source) => source.reference)).toContain("vault/qmd.md");
    expect(defaultStore.researchStore.runs[0].sources.map((source) => source.reference)).toContain("vault/obsidian.md");
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

  it("POST retry vault mining for an existing run accepts only read-only override shape", async () => {
    const qmdClient = new FakeRouteMcpClient("qmd-mcp", [{ name: "qmd.search" }], [{ path: "vault/retry.md", excerpt: "retry" }]);
    const { app } = buildApp({
      mcpClientFactory: async ({ provider }) => provider === "qmd"
        ? { client: qmdClient, mcpServerName: "qmd-mcp" }
        : null,
      searchProjectMemoryFn: async () => [],
    });
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;

    const response = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/vault-mining`, JSON.stringify({ queries: ["retry query"], qmd: { searchToolName: "qmd.search" } }), { "Content-Type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ runId, receiptCount: 1, receiptsDocumentKey: "vault-mining-receipts" });
    expect(qmdClient.calls.at(-1)?.input.query).toBe("retry query");
  });

  it("POST retry vault mining rejects invalid payloads and mutating tool overrides", async () => {
    const { app } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;

    const invalidQueries = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/vault-mining`, JSON.stringify({ queries: "bad" }), { "Content-Type": "application/json" });
    expect(invalidQueries.status).toBe(400);

    const invalidTool = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/vault-mining`, JSON.stringify({ qmd: { searchToolName: "delete" } }), { "Content-Type": "application/json" });
    expect(invalidTool.status).toBe(400);
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
    expect(body.vaultMining).toMatchObject({ receiptsDocumentKey: "vault-mining-receipts" });
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
