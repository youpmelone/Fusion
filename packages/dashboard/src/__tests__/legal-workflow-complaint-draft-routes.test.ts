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
    reviewLevel: input.reviewLevel,
    sourceType: input.sourceType,
    sourceRunId: input.sourceRunId,
    sourceMetadata: input.sourceMetadata,
  } as Task;
}

class FakeResearchStore {
  runs: ResearchRun[] = [];
  createRun(input: any): ResearchRun {
    const run = { id: `RR-${this.runs.length + 1}`, query: input.query, topic: input.topic, status: "queued", trigger: input.trigger, sources: input.sources ?? [], events: [], tags: input.tags ?? [], metadata: input.metadata, lifecycle: input.lifecycle, createdAt: "now", updatedAt: "now" } as ResearchRun;
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
  constructor(readonly label = "default") {}
  getRootDir(): string { return process.cwd(); }
  async createTask(input: any): Promise<Task> {
    const id = `${this.label}-FN-${this.tasks.length + 1}`;
    const task = makeTask({ id, title: input.title, description: input.description, column: input.column, dependencies: input.dependencies, enabledWorkflowSteps: input.enabledWorkflowSteps, assignedAgentId: input.assignedAgentId, reviewLevel: input.reviewLevel, sourceType: input.source?.sourceType, sourceRunId: input.source?.sourceRunId, sourceMetadata: input.source?.sourceMetadata });
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
    const step = { id: `${this.label}-WS-${this.workflowSteps.length + 1}`, templateId: input.templateId, name: input.name, description: input.description, mode: "prompt", phase: "pre-merge", prompt: input.prompt, toolMode: input.toolMode, enabled: true, defaultOn: false, createdAt: "now", updatedAt: "now" } as WorkflowStep;
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
  async lookupCitation(input: any): Promise<unknown> {
    return { [input.citation]: [{ citation: input.citation, case_name: "Example Authority", absolute_url: "/opinion/1/example/" }] };
  }
  async searchAuthorities(input: any): Promise<unknown> {
    return { results: [{ case_name: input.query, absolute_url: "/opinion/1/example/" }] };
  }
}

function buildApp(options: { projectStores?: Record<string, FakeTaskStore>; mcpClientFactory?: Parameters<typeof registerLegalWorkflowRoutes>[1]["mcpClientFactory"]; searchProjectMemoryFn?: Parameters<typeof registerLegalWorkflowRoutes>[1]["searchProjectMemoryFn"] } = {}) {
  const defaultStore = new FakeTaskStore("default");
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
    mcpClientFactory: options.mcpClientFactory ?? (async ({ provider }) => provider === "qmd"
      ? { client: new FakeMcpClient([{ name: "search" }], [{ path: "vault/qmd.md", excerpt: "Source cites 410 U.S. 113." }]), mcpServerName: "qmd-mcp" }
      : { client: new FakeMcpClient([{ name: "obsidian.search" }], [{ path: "vault/obsidian.md", excerpt: "Source supports chronology." }]), mcpServerName: "obsidian" }),
    searchProjectMemoryFn: options.searchProjectMemoryFn,
    courtListenerClient: new FakeCourtListenerClient(),
  });
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) return void sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
    sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
  });
  return { app, store: defaultStore };
}

function launchBody(): string {
  return JSON.stringify({ matterName: "Acme", focus: "Legal authority 410 U.S. 113", requestedArtifacts: ["claim-map", "draft-counter-lawsuit-complaint"], safeguards });
}

describe("legal workflow complaint draft routes", () => {
  it("generates a draft complaint on launch and exposes status summaries", async () => {
    const { app, store } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });

    expect(launch.status).toBe(201);
    const runId = (launch.body as any).runId;
    expect((launch.body as any).claimMap).toMatchObject({ status: "partial", claimMapDocumentKey: "claim-map" });
    expect((launch.body as any).draftComplaint).toMatchObject({
      status: "failed",
      draftComplaintDocumentKey: "draft-counter-lawsuit-complaint",
      sectionCount: 10,
      paragraphCount: expect.any(Number),
      claimDraftCount: expect.any(Number),
      sourceReferenceCount: expect.any(Number),
      sourcePathCount: expect.any(Number),
      missingProofCount: expect.any(Number),
      unresolvedGapCount: expect.any(Number),
    });
    expect((launch.body as any).draftComplaint.safetyNotice).toContain("not filing-ready");

    const status = await request(app, "GET", `/api/legal-workflows/counter-lawsuit/runs/${runId}`);
    expect(status.status).toBe(200);
    expect((status.body as any).draftComplaint).toMatchObject({ runId, status: "failed", draftComplaintDocumentKey: "draft-counter-lawsuit-complaint" });
    expect((status.body as any).vaultMining.receiptCount).toBe(4);
    expect((status.body as any).researchMemo).toBeDefined();
    expect((status.body as any).evidenceLedger).toBeDefined();
    expect((status.body as any).claimMap).toBeDefined();
    const draftDoc = store.documents.find((doc) => doc.key === "draft-counter-lawsuit-complaint");
    expect(draftDoc?.content).toContain("Draft pleading scaffold");
    expect(draftDoc?.content).toContain("Numbered allegations");
    expect(draftDoc?.content).toContain("Machine-readable manifest");
  });

  it("retries draft complaint generation for an existing run with force-only payloads", async () => {
    const { app } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;

    const retry = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/draft-counter-lawsuit-complaint`, JSON.stringify({ force: true }), { "Content-Type": "application/json" });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ runId, status: "failed", draftComplaintDocumentKey: "draft-counter-lawsuit-complaint", sectionCount: 10 });

    const invalid = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/draft-counter-lawsuit-complaint`, JSON.stringify({ force: true, paragraphs: [] }), { "Content-Type": "application/json" });
    expect(invalid.status).toBe(400);

    const badForce = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/draft-counter-lawsuit-complaint`, JSON.stringify({ force: "yes" }), { "Content-Type": "application/json" });
    expect(badForce.status).toBe(400);
  });

  it("keeps missing claim-map runs blocked and writes visible draft complaint status", async () => {
    const { app, store } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;
    store.tasks = store.tasks.filter((task) => task.sourceMetadata?.workflowStage !== "claim-map");

    const retry = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/draft-counter-lawsuit-complaint`, JSON.stringify({ force: true }), { "Content-Type": "application/json" });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: "blocked", paragraphCount: 0, draftComplaintDocumentKey: "draft-counter-lawsuit-complaint" });
    expect(JSON.stringify(retry.body)).not.toContain("filing-ready conclusion");
    expect(store.documents.some((doc) => doc.key === "draft-counter-lawsuit-complaint-status" && doc.content.includes("Status: blocked"))).toBe(true);
    expect(store.documents.some((doc) => doc.key === "draft-counter-lawsuit-complaint" && doc.content.includes("Status: blocked"))).toBe(true);
  });

  it("returns 404 for unknown draft complaint runs and uses project-scoped stores", async () => {
    const projectStores = { alpha: new FakeTaskStore("alpha"), beta: new FakeTaskStore("beta") };
    const { app } = buildApp({ projectStores });
    const alpha = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs?projectId=alpha", launchBody(), { "Content-Type": "application/json" });
    const beta = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs?projectId=beta", launchBody(), { "Content-Type": "application/json" });
    expect(alpha.status).toBe(201);
    expect(beta.status).toBe(201);
    expect(projectStores.alpha.documents.some((doc) => doc.key === "draft-counter-lawsuit-complaint")).toBe(true);
    expect(projectStores.beta.documents.some((doc) => doc.key === "draft-counter-lawsuit-complaint")).toBe(true);
    expect(projectStores.alpha.documents.every((doc) => doc.taskId.startsWith("alpha-FN-"))).toBe(true);

    const unknown = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs/CLW-missing/draft-counter-lawsuit-complaint", JSON.stringify({}), { "Content-Type": "application/json" });
    expect(unknown.status).toBe(404);
  });

  it("keeps older runs without draft complaint stages readable", async () => {
    const { app, store } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;
    store.tasks = store.tasks.filter((task) => task.sourceMetadata?.workflowStage !== "draft-counter-lawsuit-complaint");

    const status = await request(app, "GET", `/api/legal-workflows/counter-lawsuit/runs/${runId}`);
    expect(status.status).toBe(200);
    expect((status.body as any).draftComplaint).toMatchObject({ status: "not-run", sectionCount: 0, paragraphCount: 0, safetyNotice: expect.stringContaining("Draft-only") });
    expect((status.body as any).claimMap).toBeDefined();
  });
});
