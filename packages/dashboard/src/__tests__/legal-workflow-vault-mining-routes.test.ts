import express from "express";
import { describe, expect, it } from "vitest";
import type { Agent, ResearchRun, Task, TaskDocument, WorkflowStep } from "@fusion/core";
import { ApiError, sendErrorResponse } from "../api-error.js";
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
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
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
  getRootDir(): string { return process.cwd(); }
  async createTask(input: any): Promise<Task> {
    const id = `FN-${this.tasks.length + 1}`;
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
  constructor(readonly serverName: string, private readonly tools: LegalMcpTool[], private readonly result: unknown) {}
  async listTools(): Promise<LegalMcpTool[]> { return this.tools; }
  async callTool(): Promise<unknown> { return this.result; }
  async close(): Promise<void> {}
}

function buildApp() {
  const store = new FakeTaskStore();
  const agents = new FakeAgentStore();
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
  registerLegalWorkflowRoutes(ctx, {
    createAgentStore: () => agents,
    mcpClientFactory: async ({ provider }) => provider === "qmd"
      ? { client: new FakeMcpClient("qmd-mcp", [{ name: "search" }], [{ path: "vault/qmd.md", excerpt: "qmd" }]), mcpServerName: "qmd-mcp" }
      : { client: new FakeMcpClient("obsidian", [{ name: "obsidian.search" }], [{ path: "vault/obsidian.md", excerpt: "obsidian" }]), mcpServerName: "obsidian" },
  });
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) return void sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
    sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
  });
  return { app, store };
}

function launchBody(): string {
  return JSON.stringify({ matterName: "Acme", requestedArtifacts: ["research-memo"], safeguards });
}

describe("legal workflow vault-mining routes", () => {
  it("includes launch, retry, and status vault-mining summaries with receipt document references", async () => {
    const { app, store } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    expect(launch.status).toBe(201);
    const runId = (launch.body as any).runId;
    expect((launch.body as any).vaultMining).toMatchObject({ status: "completed", receiptCount: 2, receiptsDocumentKey: "vault-mining-receipts" });

    const retry = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/vault-mining`, JSON.stringify({ queries: ["Acme"], maxResultsPerProvider: 2 }), { "Content-Type": "application/json" });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ runId, receiptCount: 2, receiptsDocumentKey: "vault-mining-receipts" });

    const status = await request(app, "GET", `/api/legal-workflows/counter-lawsuit/runs/${runId}`);
    expect(status.status).toBe(200);
    expect((status.body as any).vaultMining).toMatchObject({ runId, receiptCount: 2, researchRunId: "RR-2" });
    expect(store.documents.some((doc) => doc.key === "vault-mining-receipts" && doc.content.includes("not legally verified"))).toBe(true);
  });

  it("rejects invalid retry payload fields before any MCP call", async () => {
    const { app } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    const runId = (launch.body as any).runId;
    const response = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/vault-mining`, JSON.stringify({ qmd: { searchToolName: "delete" }, command: "not allowed" }), { "Content-Type": "application/json" });
    expect(response.status).toBe(400);

    const maxResponse = await request(app, "POST", `/api/legal-workflows/counter-lawsuit/runs/${runId}/vault-mining`, JSON.stringify({ maxResultsPerProvider: 21 }), { "Content-Type": "application/json" });
    expect(maxResponse.status).toBe(400);
  });
});
