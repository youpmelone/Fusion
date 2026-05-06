import express from "express";
import { describe, expect, it } from "vitest";
import type { Agent, ResearchRun, Task, TaskDocument, WorkflowStep } from "@fusion/core";
import { ApiError, sendErrorResponse } from "../api-error.js";
import type { CourtListenerClient } from "../legal-courtlistener.js";
import type { LegalMcpClient, LegalMcpTool } from "../legal-mcp-client.js";
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
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
    enabledWorkflowSteps: input.enabledWorkflowSteps,
    assignedAgentId: input.assignedAgentId,
    sourceType: input.sourceType,
    sourceRunId: input.sourceRunId,
    sourceMetadata: input.sourceMetadata,
  };
}

class FakeResearchStore {
  runs: ResearchRun[] = [];
  createRun(input: any): ResearchRun {
    const run = { id: `RR-${this.runs.length + 1}`, query: input.query, topic: input.topic, status: "queued", trigger: input.trigger, sources: input.sources ?? [], events: [], tags: input.tags ?? [], metadata: input.metadata, createdAt: "now", updatedAt: "now" } as ResearchRun;
    this.runs.push(run);
    return run;
  }
  updateStatus(id: string, status: ResearchRun["status"], extra?: Partial<ResearchRun>): void {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error("missing run");
    Object.assign(run, extra ?? {}, { status });
  }
}

class FakeTaskStore {
  tasks: Task[] = [];
  workflowSteps: WorkflowStep[] = [];
  documents: TaskDocument[] = [];
  researchStore = new FakeResearchStore();
  constructor(readonly projectLabel = "default") {}
  getRootDir(): string { return process.cwd(); }
  async createTask(input: any): Promise<Task> {
    const id = `${this.projectLabel}-FN-${this.tasks.length + 1}`;
    const task = makeTask({ id, title: input.title, description: input.description, column: input.column, dependencies: input.dependencies, enabledWorkflowSteps: input.enabledWorkflowSteps, assignedAgentId: input.assignedAgentId, sourceType: input.source?.sourceType, sourceRunId: input.source?.sourceRunId, sourceMetadata: input.source?.sourceMetadata });
    this.tasks.push(task);
    return task;
  }
  async upsertTaskDocument(taskId: string, input: { key: string; content: string; metadata?: Record<string, unknown>; author?: string }): Promise<TaskDocument> {
    const doc = { id: `${taskId}:${input.key}`, taskId, key: input.key, content: input.content, revision: 1, author: input.author ?? "fusion", metadata: input.metadata, createdAt: "now", updatedAt: "now" } as TaskDocument;
    this.documents = this.documents.filter((candidate) => !(candidate.taskId === taskId && candidate.key === input.key));
    this.documents.push(doc);
    return doc;
  }
  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.find((doc) => doc.taskId === taskId && doc.key === key) ?? null;
  }
  async listWorkflowSteps(): Promise<WorkflowStep[]> { return this.workflowSteps; }
  async createWorkflowStep(input: any): Promise<WorkflowStep> {
    const step = { id: `WS-${this.workflowSteps.length + 1}`, templateId: input.templateId, name: input.name, description: input.description, mode: "prompt", phase: "pre-merge", prompt: input.prompt, toolMode: input.toolMode, enabled: true, defaultOn: false, createdAt: "now", updatedAt: "now" } as WorkflowStep;
    this.workflowSteps.push(step);
    return step;
  }
  async listTasks(): Promise<Task[]> { return this.tasks; }
  getResearchStore(): FakeResearchStore { return this.researchStore; }
}

class FakeAgentStore {
  agents: Agent[] = [];
  async listAgents(): Promise<Agent[]> { return this.agents; }
  async createAgent(input: any): Promise<Agent> {
    const agent = { id: `agent-${this.agents.length + 1}`, name: input.name, role: input.role, state: "idle", metadata: input.metadata, createdAt: "now", updatedAt: "now" } as Agent;
    this.agents.push(agent);
    return agent;
  }
  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const agent = this.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new Error("missing agent");
    Object.assign(agent, updates);
    return agent;
  }
}

class FakeMcpClient implements LegalMcpClient {
  constructor(private readonly tools: LegalMcpTool[], private readonly result: unknown) {}
  async listTools(): Promise<LegalMcpTool[]> { return this.tools; }
  async callTool(): Promise<unknown> { return this.result; }
  async close(): Promise<void> {}
}

class FakeCourtListenerClient implements CourtListenerClient {
  citationCalls: unknown[] = [];
  searchCalls: unknown[] = [];
  constructor(private readonly fail = false) {}
  async lookupCitation(input: any): Promise<unknown> {
    this.citationCalls.push(input);
    if (this.fail) throw new Error("CourtListener token=super-secret-token unavailable");
    return { [input.citation]: [{ citation: input.citation, case_name: "Example Authority", absolute_url: "/opinion/1/example/" }] };
  }
  async searchAuthorities(input: any): Promise<unknown> {
    this.searchCalls.push(input);
    if (this.fail) throw new Error("CourtListener token=super-secret-token unavailable");
    return { results: [{ case_name: "Example Authority", absolute_url: "/opinion/1/example/" }] };
  }
}

function buildApp(options: { courtListenerClient?: CourtListenerClient; projectStores?: Record<string, FakeTaskStore> } = {}) {
  const defaultStore = new FakeTaskStore();
  const agents = new FakeAgentStore();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const ctx = {
    router,
    store: defaultStore,
    getProjectContext: async (req: express.Request) => {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      return { store: projectId && options.projectStores ? options.projectStores[projectId] : defaultStore, engine: undefined, projectId };
    },
    rethrowAsApiError(error: unknown): never {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : String(error));
    },
  } as unknown as ApiRoutesContext;
  registerLegalWorkflowRoutes(ctx, {
    createAgentStore: () => agents,
    mcpClientFactory: async ({ provider }) => provider === "qmd"
      ? { client: new FakeMcpClient([{ name: "search" }], [{ path: "vault/qmd.md", excerpt: "Source cites 410 U.S. 113." }]), mcpServerName: "qmd-mcp" }
      : { client: new FakeMcpClient([{ name: "obsidian.search" }], [{ path: "vault/obsidian.md", excerpt: "No authorities here." }]), mcpServerName: "obsidian" },
    courtListenerClient: options.courtListenerClient ?? new FakeCourtListenerClient(),
  });
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) return void sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
    sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
  });
  return { app, store: defaultStore };
}

function launchBody(): string {
  return JSON.stringify({ matterName: "Acme", focus: "Legal authority 410 U.S. 113", requestedArtifacts: ["research-memo"], safeguards });
}

describe("legal workflow CourtListener routes", () => {
  it("includes automatic launch validation, retry validation, and status summaries", async () => {
    const courtListenerClient = new FakeCourtListenerClient();
    const { app, store } = buildApp({ courtListenerClient });
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    expect(launch.status).toBe(201);
    const runId = (launch.body as any).runId;
    expect((launch.body as any).vaultMining.receiptCount).toBe(4);
    expect((launch.body as any).authorityValidation).toMatchObject({ status: "completed", validatedCount: 3, authorityValidationDocumentKey: "courtlistener-authority-validation" });
    expect((launch.body as any).authorityValidation.safetyNotice).toContain("not good-law verification");
    expect(courtListenerClient.citationCalls.length).toBeGreaterThan(0);

    const retry = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/authority-validation`, JSON.stringify({ citations: ["123 F.3d 456"], maxResultsPerCandidate: 1 }), { "Content-Type": "application/json" });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ runId, status: "completed", validatedCount: 4 });
    expect((retry.body as any).safetyNotice).toContain("not attorney judgment");

    const status = await request(app, "GET", `/api/legal-workflows/counter-lawsuit/runs/${runId}`);
    expect(status.status).toBe(200);
    expect((status.body as any).authorityValidation).toMatchObject({ runId, status: "completed", authorityValidationDocumentKey: "courtlistener-authority-validation" });
    expect(store.documents.some((doc) => doc.key === "courtlistener-authority-validation" && doc.content.includes("not filing-format citation checking"))).toBe(true);
    expect(store.researchStore.runs.some((run) => run.trigger === "legal-counter-lawsuit-courtlistener-validation" && run.sources.length > 0)).toBe(true);
  });

  it("rejects invalid retry payloads and returns 404 for unknown runs", async () => {
    const { app } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;
    const invalid = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/authority-validation`, JSON.stringify({ citations: "bad", token: "not allowed" }), { "Content-Type": "application/json" });
    expect(invalid.status).toBe(400);

    const unknown = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs/CLW-missing/authority-validation", JSON.stringify({ citations: ["1 U.S. 1"] }), { "Content-Type": "application/json" });
    expect(unknown.status).toBe(404);
  });

  it("surfaces unavailable CourtListener diagnostics without leaking tokens", async () => {
    const { app, store } = buildApp({ courtListenerClient: new FakeCourtListenerClient(true) });
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    expect(launch.status).toBe(201);
    expect((launch.body as any).authorityValidation.status).toBe("unavailable");
    expect(JSON.stringify(launch.body)).not.toContain("super-secret-token");
    expect(JSON.stringify(store.documents)).not.toContain("super-secret-token");
  });

  it("uses the project-scoped task store", async () => {
    const projectStores = { alpha: new FakeTaskStore("alpha"), beta: new FakeTaskStore("beta") };
    const { app } = buildApp({ projectStores });
    const alpha = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs?projectId=alpha", launchBody(), { "Content-Type": "application/json" });
    const beta = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs?projectId=beta", launchBody(), { "Content-Type": "application/json" });
    expect(alpha.status).toBe(201);
    expect(beta.status).toBe(201);
    expect(projectStores.alpha.tasks.every((task) => task.id.startsWith("alpha-FN-"))).toBe(true);
    expect(projectStores.beta.tasks.every((task) => task.id.startsWith("beta-FN-"))).toBe(true);
  });
});
