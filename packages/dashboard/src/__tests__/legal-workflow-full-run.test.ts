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

const requiredStageDocumentKeys = [
  "research-memo",
  "evidence-ledger",
  "claim-map",
  "draft-counter-lawsuit-complaint",
  "red-team-report",
  "lineage-scoring-log",
] as const;

const requiredPrimaryDocumentKeys = [
  "vault-mining-receipts",
  "courtlistener-authority-validation",
  ...requiredStageDocumentKeys,
] as const;

interface VerificationIssue {
  code: string;
  message: string;
}

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
    status: input.status,
    error: input.error,
  } as Task;
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
  documents: TaskDocument[] = [];
  researchStore = new FakeResearchStore();

  constructor(readonly label = "default") {}

  getRootDir(): string {
    return process.cwd();
  }

  async createTask(input: any): Promise<Task> {
    const id = `${this.label}-FN-${this.tasks.length + 1}`;
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

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; metadata?: Record<string, unknown>; author?: string }): Promise<TaskDocument> {
    const document = {
      id: `${taskId}:${input.key}`,
      taskId,
      key: input.key,
      content: input.content,
      revision: 1,
      author: input.author ?? "fusion",
      metadata: input.metadata ?? {},
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument;
    this.documents = this.documents.filter((candidate) => !(candidate.taskId === taskId && candidate.key === input.key));
    this.documents.push(document);
    return document;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.find((document) => document.taskId === taskId && document.key === key) ?? null;
  }

  async listWorkflowSteps(): Promise<WorkflowStep[]> {
    return this.workflowSteps;
  }

  async createWorkflowStep(input: any): Promise<WorkflowStep> {
    const step = {
      id: `${this.label}-WS-${this.workflowSteps.length + 1}`,
      templateId: input.templateId,
      name: input.name,
      description: input.description,
      mode: "prompt",
      phase: "pre-merge",
      prompt: input.prompt,
      toolMode: input.toolMode,
      enabled: true,
      defaultOn: false,
      createdAt: "now",
      updatedAt: "now",
    } as WorkflowStep;
    this.workflowSteps.push(step);
    return step;
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  getResearchStore(): FakeResearchStore {
    return this.researchStore;
  }
}

class FakeAgentStore {
  agents: Agent[] = [];

  async listAgents(): Promise<Agent[]> {
    return this.agents;
  }

  async createAgent(input: any): Promise<Agent> {
    const agent = {
      id: `agent-${this.agents.length + 1}`,
      name: input.name,
      role: input.role,
      state: "idle",
      metadata: input.metadata,
      createdAt: "now",
      updatedAt: "now",
    } as Agent;
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

  async listTools(): Promise<LegalMcpTool[]> {
    return this.tools;
  }

  async callTool(): Promise<unknown> {
    return this.result;
  }

  async close(): Promise<void> {}
}

class ThrowingMcpClient implements LegalMcpClient {
  async listTools(): Promise<LegalMcpTool[]> {
    throw new Error("mock provider unavailable; token sk-test-123 must not be persisted");
  }

  async callTool(): Promise<unknown> {
    throw new Error("mock provider unavailable; Authorization: Bearer secretvalue123 must not be persisted");
  }

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

class ThrowingCourtListenerClient implements CourtListenerClient {
  async lookupCitation(): Promise<unknown> {
    throw new Error("CourtListener unavailable with API_TOKEN=abc123456789");
  }

  async searchAuthorities(): Promise<unknown> {
    throw new Error("CourtListener unavailable with Authorization: Bearer abc123456789");
  }
}

function buildApp(options: {
  mcpClientFactory?: Parameters<typeof registerLegalWorkflowRoutes>[1]["mcpClientFactory"];
  courtListenerClient?: CourtListenerClient;
} = {}) {
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
    mcpClientFactory: options.mcpClientFactory ?? (async ({ provider }) => provider === "qmd"
      ? { client: new FakeMcpClient([{ name: "search" }], [{ path: "vault/qmd.md", excerpt: "Source cites 410 U.S. 113." }]), mcpServerName: "qmd-mcp" }
      : { client: new FakeMcpClient([{ name: "obsidian.search" }], [{ path: "vault/obsidian.md", excerpt: "Source supports chronology." }]), mcpServerName: "obsidian" }),
    courtListenerClient: options.courtListenerClient ?? new FakeCourtListenerClient(),
  });
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) return void sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
    sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
  });
  return { app, store };
}

function launchBody(): string {
  return JSON.stringify({
    matterName: "Acme",
    focus: "Legal authority 410 U.S. 113",
    requestedArtifacts: [...requiredStageDocumentKeys],
    safeguards,
  });
}

function parseManifest(document: Pick<TaskDocument, "content">): { ok: true } | { ok: false; message: string } {
  const match = /```json\s*([\s\S]*?)\s*```/i.exec(document.content);
  if (!match) return { ok: false, message: "missing JSON manifest block" };
  try {
    JSON.parse(match[1]);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function collectFullRunVerificationIssues(status: any, documents: Array<Pick<TaskDocument, "key" | "content">>): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const artifactKeys = new Set<string>(Array.isArray(status.artifactKeys) ? status.artifactKeys : []);
  const stageDocumentKeys = new Set<string>((status.stageTasks ?? []).map((task: any) => task.documentKey).filter((key: unknown): key is string => typeof key === "string"));
  const documentByKey = new Map(documents.map((document) => [document.key, document]));

  for (const key of requiredStageDocumentKeys) {
    if (!artifactKeys.has(key) || !stageDocumentKeys.has(key)) {
      issues.push({ code: "missing-stage-task", message: `${key} stage task is missing from the run status` });
    }
    const artifact = (status.artifacts ?? []).find((candidate: any) => candidate.documentKey === key);
    if (!artifact) {
      issues.push({ code: "missing-artifact-status", message: `${key} artifact status is missing` });
    } else if (artifact.status !== "ready") {
      issues.push({ code: "incomplete-artifact", message: `${key} artifact is ${artifact.status}` });
    }
  }

  for (const key of requiredPrimaryDocumentKeys) {
    const document = documentByKey.get(key);
    if (!document) {
      issues.push({ code: "missing-primary-document", message: `${key} document is missing` });
      continue;
    }
    const manifest = parseManifest(document);
    if (!manifest.ok) {
      issues.push({ code: "malformed-primary-manifest", message: `${key} manifest could not be parsed: ${manifest.message}` });
    }
  }

  for (const key of ["vaultMining", "authorityValidation", "researchMemo", "evidenceLedger", "claimMap", "draftComplaint", "redTeamReport", "lineageScoringLog"]) {
    const summary = status[key];
    if (!summary) {
      issues.push({ code: "missing-summary", message: `${key} summary is missing` });
      continue;
    }
    if (["blocked", "partial", "failed", "not-run"].includes(summary.status)) {
      issues.push({ code: "incomplete-summary", message: `${key} summary is ${summary.status}` });
    }
  }

  const lineage = status.lineageScoringLog;
  if (!lineage) {
    issues.push({ code: "lineage-summary-missing", message: "lineageScoringLog summary is required for a passing full-run verification" });
  } else {
    for (const [field, code] of [
      ["promptTraceCount", "lineage-prompts-missing"],
      ["searchTraceCount", "lineage-searches-missing"],
      ["draftVersionCount", "lineage-draft-versions-missing"],
      ["critiqueScoreCount", "lineage-critique-scores-missing"],
      ["rejectedVariantCount", "lineage-rejected-variants-missing"],
    ] as const) {
      if (typeof lineage[field] !== "number" || lineage[field] <= 0) {
        issues.push({ code, message: `${field} must be greater than zero` });
      }
    }
    if (lineage.promotionDecision !== "not-promoted") {
      issues.push({ code: "lineage-promotion-rationale-missing", message: "promotion rationale must keep the prototype not-promoted" });
    }
  }

  if ((status.authorityValidation?.diagnostics ?? []).some((diagnostic: any) => diagnostic.status === "error" || diagnostic.status === "unavailable")) {
    issues.push({ code: "authority-verification-gap", message: "CourtListener provider errors remain verification gaps" });
  }
  if ((status.vaultMining?.providerDiagnostics ?? []).some((diagnostic: any) => diagnostic.status === "error" || diagnostic.status === "unavailable")) {
    issues.push({ code: "vault-provider-gap", message: "vault provider errors remain source-mining gaps" });
  }

  return issues;
}

describe("legal workflow full-run failure guards", () => {
  it("does not let a missing required artifact stage or document pass full-run verification", async () => {
    const { app, store } = buildApp();
    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    expect(launch.status).toBe(201);
    const runId = (launch.body as any).runId;

    store.tasks = store.tasks.filter((task) => task.sourceMetadata?.workflowStage !== "lineage-scoring-log");
    store.documents = store.documents.filter((document) => document.key !== "red-team-report");
    for (const task of store.tasks) task.column = "done";

    const status = await request(app, "GET", `/api/legal-workflows/counter-lawsuit/runs/${runId}`);
    expect(status.status).toBe(200);
    expect((status.body as any).status).not.toBe("failed");

    const issues = collectFullRunVerificationIssues(status.body, store.documents);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-stage-task", message: expect.stringContaining("lineage-scoring-log") }),
      expect.objectContaining({ code: "missing-primary-document", message: expect.stringContaining("red-team-report") }),
      expect.objectContaining({ code: "incomplete-summary", message: expect.stringContaining("lineageScoringLog summary is not-run") }),
    ]));
    expect(issues.some((issue) => ["missing-stage-task", "missing-primary-document", "incomplete-summary"].includes(issue.code))).toBe(true);
  });

  it("represents mocked-failing external providers as diagnostics and verification gaps, not successful verified evidence", async () => {
    const { app, store } = buildApp({
      mcpClientFactory: async () => ({ client: new ThrowingMcpClient(), mcpServerName: "mock-mcp" }),
      courtListenerClient: new ThrowingCourtListenerClient(),
    });

    const launch = await request(app, "POST", "/api/legal-workflows/counter-lawsuit/runs", launchBody(), { "Content-Type": "application/json" });
    expect(launch.status).toBe(201);
    expect(["failed", "unavailable"]).toContain((launch.body as any).vaultMining.status);
    expect((launch.body as any).vaultMining.providerDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: expect.stringMatching(/error|unavailable/) })]));
    expect(["failed", "unavailable"]).toContain((launch.body as any).authorityValidation.status);
    expect((launch.body as any).authorityValidation.validatedCount).toBe(0);
    expect((launch.body as any).authorityValidation.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: "error" })]));

    const serialized = JSON.stringify({ body: launch.body, documents: store.documents });
    expect(serialized).not.toContain("sk-test-123");
    expect(serialized).not.toContain("secretvalue123");
    expect(serialized).not.toContain("API_TOKEN=abc123456789");

    const issues = collectFullRunVerificationIssues(launch.body, store.documents);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "vault-provider-gap" }),
      expect.objectContaining({ code: "authority-verification-gap" }),
    ]));
  });

  it("cannot pass when lineage/scoring omits prompts, searches, draft versions, critique scores, rejected variants, or promotion rationale", () => {
    const issues = collectFullRunVerificationIssues({
      status: "completed",
      artifactKeys: [...requiredStageDocumentKeys],
      stageTasks: requiredStageDocumentKeys.map((documentKey, index) => ({ id: `stage-${index}`, documentKey })),
      artifacts: requiredStageDocumentKeys.map((documentKey) => ({ documentKey, status: "ready" })),
      vaultMining: { status: "completed", providerDiagnostics: [] },
      authorityValidation: { status: "completed", diagnostics: [], validatedCount: 1 },
      researchMemo: { status: "completed" },
      evidenceLedger: { status: "completed" },
      claimMap: { status: "completed" },
      draftComplaint: { status: "completed" },
      redTeamReport: { status: "completed" },
      lineageScoringLog: {
        status: "completed",
        promptTraceCount: 0,
        searchTraceCount: 0,
        draftVersionCount: 0,
        critiqueScoreCount: 0,
        rejectedVariantCount: 0,
        promotionDecision: undefined,
      },
    }, requiredPrimaryDocumentKeys.map((key) => ({ key, content: "```json\n{}\n```" })) as any);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "lineage-prompts-missing" }),
      expect.objectContaining({ code: "lineage-searches-missing" }),
      expect.objectContaining({ code: "lineage-draft-versions-missing" }),
      expect.objectContaining({ code: "lineage-critique-scores-missing" }),
      expect.objectContaining({ code: "lineage-rejected-variants-missing" }),
      expect.objectContaining({ code: "lineage-promotion-rationale-missing" }),
    ]));
  });

  it("surfaces malformed primary artifact manifests as parse diagnostics and never defaults them to completed", () => {
    const issues = collectFullRunVerificationIssues({
      status: "completed",
      artifactKeys: [...requiredStageDocumentKeys],
      stageTasks: requiredStageDocumentKeys.map((documentKey, index) => ({ id: `stage-${index}`, documentKey })),
      artifacts: requiredStageDocumentKeys.map((documentKey) => ({ documentKey, status: "ready" })),
      vaultMining: { status: "completed", providerDiagnostics: [] },
      authorityValidation: { status: "completed", diagnostics: [], validatedCount: 1 },
      researchMemo: { status: "completed" },
      evidenceLedger: { status: "completed" },
      claimMap: { status: "completed" },
      draftComplaint: { status: "completed" },
      redTeamReport: { status: "completed" },
      lineageScoringLog: {
        status: "completed",
        promptTraceCount: 1,
        searchTraceCount: 1,
        draftVersionCount: 1,
        critiqueScoreCount: 1,
        rejectedVariantCount: 1,
        promotionDecision: "not-promoted",
      },
    }, requiredPrimaryDocumentKeys.map((key) => ({
      key,
      content: key === "claim-map" ? "```json\n{ not valid json\n```" : "```json\n{}\n```",
    })) as any);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "malformed-primary-manifest", message: expect.stringContaining("claim-map") }),
    ]));
    expect(issues.some((issue) => issue.code === "malformed-primary-manifest")).toBe(true);
  });
});
