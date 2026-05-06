import { describe, expect, it } from "vitest";
import type { Agent, Task, WorkflowStep } from "@fusion/core";
import { ApiError } from "../api-error.js";
import {
  COUNTER_LAWSUIT_RUN_DOCUMENT_KEY,
  COUNTER_LAWSUIT_STAGE_DEFINITIONS,
  COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY,
  DEFAULT_CODEX_LEGAL_SKILL_NAMES,
  getCodexSkillSetKey,
  getCounterLawsuitWorkflowRunStatus,
  startCounterLawsuitWorkflowRun,
  validateCounterLawsuitLaunchInput,
} from "../legal-workflow-orchestrator.js";

const validSafeguards = {
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
  documents: Array<{ taskId: string; key: string; content: string; author?: string; metadata?: Record<string, unknown> }> = [];
  createTaskInputs: unknown[] = [];

  async createTask(input: any): Promise<Task> {
    this.createTaskInputs.push(input);
    const id = `FN-${String(this.tasks.length + 1).padStart(3, "0")}`;
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

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }) {
    this.documents.push({ taskId, ...input });
    return { id: `${taskId}:${input.key}`, taskId, key: input.key, content: input.content, author: input.author ?? "user", metadata: input.metadata ?? {}, createdAt: "now", updatedAt: "now" };
  }

  async listWorkflowSteps(): Promise<WorkflowStep[]> {
    return this.workflowSteps;
  }

  async createWorkflowStep(input: any): Promise<WorkflowStep> {
    const step = {
      id: `WS-${String(this.workflowSteps.length + 1).padStart(3, "0")}`,
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
  createCalls = 0;
  updateCalls = 0;

  async listAgents(): Promise<Agent[]> {
    return this.agents;
  }

  async createAgent(input: any): Promise<Agent> {
    this.createCalls += 1;
    const agent: Agent = {
      id: `agent-${String(this.agents.length + 1).padStart(3, "0")}`,
      name: input.name,
      role: input.role,
      state: "idle",
      createdAt: "now",
      updatedAt: "now",
      metadata: input.metadata ?? {},
      title: input.title,
      icon: input.icon,
      instructionsText: input.instructionsText,
    };
    this.agents.push(agent);
    return agent;
  }

  async updateAgent(agentId: string, updates: any): Promise<Agent> {
    this.updateCalls += 1;
    const index = this.agents.findIndex((agent) => agent.id === agentId);
    if (index === -1) throw new Error("agent not found");
    this.agents[index] = { ...this.agents[index], ...updates, updatedAt: "later" };
    return this.agents[index];
  }
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    matterName: "Acme response matter",
    focus: "Retaliatory filing timeline",
    vaultScope: "client/acme/litigation",
    requestedArtifacts: ["research-memo"],
    safeguards: validSafeguards,
    ...overrides,
  };
}

describe("validateCounterLawsuitLaunchInput", () => {
  it("requires matterName and all three safety acknowledgments", () => {
    expect(() => validateCounterLawsuitLaunchInput(null)).toThrow("request body must be an object");
    expect(() => validateCounterLawsuitLaunchInput([])).toThrow("request body must be an object");
    expect(() => validateCounterLawsuitLaunchInput("bad body")).toThrow("request body must be an object");
    expect(() => validateCounterLawsuitLaunchInput(validInput({ matterName: "" }))).toThrow(ApiError);
    expect(() => validateCounterLawsuitLaunchInput(validInput({ safeguards: { ...validSafeguards, citationSourceVerification: false } }))).toThrow("safeguards.citationSourceVerification must be true");
    expect(() => validateCounterLawsuitLaunchInput(validInput({ safeguards: { ...validSafeguards, opposingCounselRedTeam: false } }))).toThrow("safeguards.opposingCounselRedTeam must be true");
    expect(() => validateCounterLawsuitLaunchInput(validInput({ safeguards: { ...validSafeguards, preserveLineage: false } }))).toThrow("safeguards.preserveLineage must be true");
  });

  it("defaults omitted Codex skill names and records unspecified source scope", () => {
    const normalized = validateCounterLawsuitLaunchInput(validInput({ focus: undefined, vaultScope: undefined }));

    expect(normalized.codexSkillNames).toEqual([...DEFAULT_CODEX_LEGAL_SKILL_NAMES]);
    expect(normalized.codexSkillSource).toBe("default");
    expect(normalized.sourceScopeStatus).toBe("unspecified");
  });

  it("accepts user-supplied non-empty Codex skill names", () => {
    const normalized = validateCounterLawsuitLaunchInput(validInput({ codexSkillNames: [" legal-research ", "custom-litigation"] }));

    expect(normalized.codexSkillNames).toEqual(["legal-research", "custom-litigation"]);
    expect(normalized.codexSkillSource).toBe("user");
  });

  it("rejects invalid Codex skill names", () => {
    expect(() => validateCounterLawsuitLaunchInput(validInput({ codexSkillNames: [] }))).toThrow("codexSkillNames must contain at least one skill name");
    expect(() => validateCounterLawsuitLaunchInput(validInput({ codexSkillNames: ["legal-research", " "] }))).toThrow("codexSkillNames must contain only non-empty strings");
  });
});

describe("startCounterLawsuitWorkflowRun", () => {
  it("queues the exact stage DAG in todo with workflow steps, source metadata, agents, and documents", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();

    const response = await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ codexSkillNames: ["legal-research", "legal-drafting"] }),
      now: () => new Date("2026-05-05T12:00:00.000Z"),
      generateRunId: () => "CLW-test-run",
    });

    expect(response.runId).toBe("CLW-test-run");
    expect(response.status).toBe("queued");
    expect(response.taskId).toBe("FN-001");
    expect(response.task.id).toBe("FN-001");
    expect(response.codexSkillSource).toBe("user");
    expect(response.codexSkillNames).toEqual(["legal-research", "legal-drafting"]);
    expect(taskStore.tasks).toHaveLength(6);
    expect(taskStore.tasks.map((task) => task.column)).toEqual(["todo", "todo", "todo", "todo", "todo", "todo"]);
    expect(taskStore.tasks.map((task) => task.dependencies)).toEqual([[], ["FN-001"], ["FN-002"], ["FN-003"], ["FN-004"], ["FN-005"]]);
    expect(response.stageTasks.map((stage) => stage.stage)).toEqual(COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage) => stage.stage));
    expect(response.artifactKeys).toEqual([
      "research-memo",
      "evidence-ledger",
      "claim-map",
      "draft-counter-lawsuit-complaint",
      "red-team-report",
      "lineage-scoring-log",
    ]);

    const workflowStepIds = taskStore.workflowSteps.map((step) => step.id);
    expect(workflowStepIds).toEqual(["WS-001", "WS-002", "WS-003"]);
    expect(taskStore.workflowSteps.every((step) => step.mode === "prompt" && step.prompt.includes("REQUEST REVISION"))).toBe(true);
    expect(taskStore.workflowSteps[0].prompt).toContain("REQUEST REVISION if any factual claim");
    expect(taskStore.workflowSteps[0].prompt).toContain("courtlistener-authority-validation");
    expect(taskStore.workflowSteps[0].prompt).toContain("missing, unmatched, ambiguous, or unavailable CourtListener results");
    expect(taskStore.workflowSteps[0].prompt).toContain("Explicitly labeled unverified authority notes may remain only as unresolved research gaps");
    expect(taskStore.tasks.every((task) => JSON.stringify(task.enabledWorkflowSteps) === JSON.stringify(workflowStepIds))).toBe(true);

    expect(agentStore.createCalls).toBe(6);
    expect(taskStore.tasks.map((task) => task.assignedAgentId)).toEqual(agentStore.agents.map((agent) => agent.id));
    expect(agentStore.agents.every((agent) => agent.metadata.legalWorkflowKind === "counter-lawsuit-prototype")).toBe(true);
    expect(agentStore.agents.every((agent) => agent.metadata.codexSkillSetKey === getCodexSkillSetKey(["legal-research", "legal-drafting"]))).toBe(true);
    expect(agentStore.agents.every((agent) => JSON.stringify(agent.metadata.skills) === JSON.stringify(["legal-research", "legal-drafting"]))).toBe(true);

    for (const [index, task] of taskStore.tasks.entries()) {
      expect(task.sourceType).toBe("dashboard_ui");
      expect(task.sourceRunId).toBe("CLW-test-run");
      expect(task.sourceMetadata).toMatchObject({
        workflowKind: "counter-lawsuit-prototype",
        workflowRunId: "CLW-test-run",
        workflowStage: COUNTER_LAWSUIT_STAGE_DEFINITIONS[index].stage,
        workflowStageIndex: index,
        expectedArtifact: COUNTER_LAWSUIT_STAGE_DEFINITIONS[index].expectedArtifact,
        codexSkillNames: ["legal-research", "legal-drafting"],
        codexSkillSource: "user",
        codexSkillSetKey: getCodexSkillSetKey(["legal-research", "legal-drafting"]),
        sourceScopeStatus: "specified",
      });
      expect(task.sourceMetadata?.requiredSafetyGates).toEqual([
        "citation-source-verification",
        "opposing-counsel-red-team",
        "lineage-preservation",
      ]);
    }

    const runDocument = taskStore.documents.find((document) => document.key === COUNTER_LAWSUIT_RUN_DOCUMENT_KEY);
    expect(runDocument?.taskId).toBe("FN-001");
    expect(runDocument?.content).toContain("Codex skill source: user");
    expect(runDocument?.content).toContain("This server orchestration does not verify legal claims by itself");

    const stageDocuments = taskStore.documents.filter((document) => document.key === COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY);
    expect(stageDocuments).toHaveLength(6);
    expect(stageDocuments[0].content).toContain("Output document key: research-memo");
    expect(stageDocuments[5].content).toContain("Output document key: lineage-scoring-log");
  });

  it("does not reject omitted source scope and tells generated prompts to treat discovery as unverified", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();

    const response = await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ focus: "legal theory focus only", vaultScope: undefined }),
      generateRunId: () => "CLW-unspecified",
    });

    expect(response.sourceScopeStatus).toBe("unspecified");
    expect(response.codexSkillSource).toBe("default");
    expect(response.codexSkillNames).toEqual([...DEFAULT_CODEX_LEGAL_SKILL_NAMES]);
    expect(taskStore.tasks[0].description).toContain("Focus: legal theory focus only");
    expect(taskStore.tasks[0].description).toContain("Source scope status: unspecified");
    expect(taskStore.tasks[0].description).toContain("Treat all source discovery as unverified until QMD MCP or Obsidian MCP mining supplies receipts");
  });

  it("does not mutate agents assigned to earlier queued runs when a later run supplies different skills", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();

    await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ focus: undefined, vaultScope: undefined }),
      generateRunId: () => "CLW-default-skills",
    });
    const firstRunAgentIds = taskStore.tasks.slice(0, 6).map((task) => task.assignedAgentId);

    await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ codexSkillNames: ["legal-research", "custom-litigation"] }),
      generateRunId: () => "CLW-custom-skills",
    });

    expect(agentStore.agents).toHaveLength(12);
    for (const agentId of firstRunAgentIds) {
      const agent = agentStore.agents.find((candidate) => candidate.id === agentId);
      expect(agent?.metadata.skills).toEqual([...DEFAULT_CODEX_LEGAL_SKILL_NAMES]);
    }
    for (const task of taskStore.tasks.slice(6, 12)) {
      const agent = agentStore.agents.find((candidate) => candidate.id === task.assignedAgentId);
      expect(agent?.metadata.skills).toEqual(["legal-research", "custom-litigation"]);
    }
  });

  it("recreates stale matching workflow steps instead of reusing disabled or non-prompt safety gates", async () => {
    const taskStore = new FakeTaskStore();
    taskStore.workflowSteps = [
      { id: "WS-stale-1", templateId: "counter-lawsuit-citation-source-verification", name: "Counter-lawsuit citation/source verification", description: "", mode: "script", phase: "pre-merge", prompt: "", enabled: true, createdAt: "now", updatedAt: "now" },
      { id: "WS-stale-2", templateId: "counter-lawsuit-opposing-counsel-red-team", name: "Counter-lawsuit opposing-counsel red-team review", description: "", mode: "prompt", phase: "pre-merge", prompt: "REQUEST REVISION for formatting only", toolMode: "readonly", enabled: true, createdAt: "now", updatedAt: "now" },
      { id: "WS-stale-3", templateId: "counter-lawsuit-lineage-preservation", name: "Counter-lawsuit lineage preservation", description: "", mode: "prompt", phase: "post-merge", prompt: "REQUEST REVISION", toolMode: "readonly", enabled: false, createdAt: "now", updatedAt: "now" },
    ] as WorkflowStep[];
    const agentStore = new FakeAgentStore();

    const response = await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput(),
      generateRunId: () => "CLW-stale-steps",
    });

    expect(response.workflowStepIds).toEqual(["WS-004", "WS-005", "WS-006"]);
    expect(taskStore.workflowSteps.slice(3).every((step) => step.mode === "prompt" && step.phase === "pre-merge" && step.toolMode === "readonly" && step.enabled && step.prompt.includes("REQUEST REVISION"))).toBe(true);
  });

  it("refreshes stale matching agents before assignment so runtime skill handoff is correct", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();
    const defaultSkillSetKey = getCodexSkillSetKey([...DEFAULT_CODEX_LEGAL_SKILL_NAMES]);
    agentStore.agents = COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage, index) => ({
      id: `agent-existing-${index}`,
      name: `Legal workflow — counter-lawsuit-prototype — ${stage.legalWorkflowRole} — skills-${defaultSkillSetKey}`,
      role: "executor",
      state: "idle",
      createdAt: "now",
      updatedAt: "now",
      metadata: {
        legalWorkflowKind: "counter-lawsuit-prototype",
        legalWorkflowRole: stage.legalWorkflowRole,
        codexSkillSetKey: defaultSkillSetKey,
        skills: ["wrong-skill"],
      },
    })) as Agent[];

    const response = await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ focus: undefined, vaultScope: undefined }),
      generateRunId: () => "CLW-refresh-agents",
    });

    expect(agentStore.createCalls).toBe(0);
    expect(agentStore.updateCalls).toBe(6);
    for (const task of taskStore.tasks) {
      const agent = agentStore.agents.find((candidate) => candidate.id === task.assignedAgentId);
      expect(agent?.metadata.skills).toEqual([...DEFAULT_CODEX_LEGAL_SKILL_NAMES]);
    }
    expect(response.agentIds).toEqual(agentStore.agents.map((agent) => agent.id));
  });

  it("reuses exact durable legal workflow agents and exact safety workflow steps idempotently", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();

    const first = await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ focus: undefined, vaultScope: undefined }),
      generateRunId: () => "CLW-first-reuse",
    });
    taskStore.tasks = [];
    taskStore.documents = [];
    agentStore.createCalls = 0;
    agentStore.updateCalls = 0;

    const second = await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ focus: undefined, vaultScope: undefined }),
      generateRunId: () => "CLW-second-reuse",
    });

    expect(agentStore.createCalls).toBe(0);
    expect(agentStore.updateCalls).toBe(0);
    expect(taskStore.workflowSteps).toHaveLength(3);
    expect(second.workflowStepIds).toEqual(first.workflowStepIds);
    expect(second.agentIds).toEqual(first.agentIds);
  });
});

describe("generated legal workflow prompts", () => {
  it("encode draft-only safety boundaries and integration handoff language without promoting output as verified", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();

    await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput({ focus: undefined, vaultScope: undefined }),
      generateRunId: () => "CLW-prompts",
    });

    for (const [index, task] of taskStore.tasks.entries()) {
      const expectedDocumentKey = COUNTER_LAWSUIT_STAGE_DEFINITIONS[index].documentKey;
      expect(task.description).toContain("Use the existing installed Codex legal skills assigned to this durable agent");
      expect(task.description).toContain("Mine facts through QMD MCP and Obsidian MCP when those integrations are available");
      expect(task.description).toContain("Read task document key `courtlistener-authority-validation` when it exists");
      expect(task.description).toContain("Treat missing, unmatched, ambiguous, or unavailable CourtListener results as unresolved authority gaps");
      expect(task.description).toContain("not good-law verification");
      expect(task.description).toContain("not citation-format validation");
      expect(task.description).toContain("not filing-ready");
      expect(task.description).toContain("not promoted for filing");
      expect(task.description).toContain("explicitly mark the affected facts, evidence, authorities, or receipts as unverified");
      expect(task.description).toContain("Do not invent citations, quotes, docket entries, CourtListener matches, or source receipts");
      expect(task.description).toContain(`Write the primary output to task document key \`${expectedDocumentKey}\``);
      expect(task.description).toContain("All generated materials are drafts only");
      expect(task.description).toContain("not legal advice");
      expect(task.description).toContain("not verified facts");
      expect(task.description).toContain("not human verification");
      expect(task.description).toContain("not promoted for filing");
      expect(task.description).toContain("Safety gates can surface blockers, but they do not create filing readiness or attorney review");
      expect(task.description).not.toMatch(/verified and reliable/i);
    }

    expect(taskStore.tasks[0].description).toContain("`vault-mining-receipts` as the required first source manifest");
    expect(taskStore.tasks[0].description).toContain("source-linked but unverified");
    expect(taskStore.tasks[0].description).toContain("`research-memo-status` blockers as unresolved prerequisites");
    expect(taskStore.tasks[1].description).toContain("read task document key `research-memo` from the research-memo stage task");
    expect(taskStore.tasks[1].description).toContain("research-memo-status` reports blocked, partial, or failed status");
    expect(taskStore.tasks[1].description).toContain("Do not depend on a pre-existing `evidence-ledger`; this stage creates it");
    expect(taskStore.tasks[2].description).toContain("read task document key `evidence-ledger` from the evidence-ledger stage task");
    expect(taskStore.tasks[2].description).toContain("`evidence-ledger-status` reports blocked, partial, failed, stale, or unresolved prerequisites");
    expect(taskStore.tasks[2].description).toContain("Do not depend on a pre-existing `claim-map`; this stage creates it");
    expect(taskStore.tasks[3].description).toContain("task document key `claim-map` from the claim-map stage task");
    expect(taskStore.tasks[3].description).toContain("`claim-map-status` reports blocked, partial, failed, stale, or unresolved prerequisites");
    expect(taskStore.tasks[3].description).toContain("Do not depend on a pre-existing `draft-counter-lawsuit-complaint`; this stage creates it");
    expect(taskStore.tasks[4].description).toContain("read task document key `draft-counter-lawsuit-complaint`");
    expect(taskStore.tasks[4].description).toContain("draft-counter-lawsuit-complaint-status blockers as unresolved prerequisites");
    expect(taskStore.tasks[4].description).toContain("artifact to attack");
    expect(taskStore.tasks[5].description).toContain("`draft-counter-lawsuit-complaint-status`");
    expect(taskStore.tasks[5].description).toContain("preserve them in lineage");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key research-memo for source-linked evidence");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key research-memo-status");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key evidence-ledger for source-linked fact rows");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key evidence-ledger-status");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key claim-map for claim groups, element rows, allegation-to-evidence links, missing-proof entries");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key claim-map-status");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key draft-counter-lawsuit-complaint for draft complaint paragraphs");
    expect(taskStore.workflowSteps[0].prompt).toContain("source references, missing-proof blockers, unresolved authorities, red-team-pending labels");
    expect(taskStore.workflowSteps[0].prompt).toContain("Check task document key draft-counter-lawsuit-complaint-status");
    expect(taskStore.workflowSteps[0].prompt).toContain("lookup-only authority validation");
    expect(taskStore.workflowSteps[1].prompt).toContain("draft-counter-lawsuit-complaint as the draft artifact to attack");
    expect(taskStore.workflowSteps[1].prompt).toContain("This workflow step does not generate the FN-015 red-team report");
    expect(taskStore.workflowSteps[2].prompt).toContain("draft complaint paragraph IDs");
    expect(taskStore.workflowSteps[2].prompt).toContain("draft-counter-lawsuit-complaint-status reports blocked, partial, failed, stale, or unresolved prerequisites");

    const allDocumentContent = taskStore.documents.map((document) => document.content).join("\n---\n");
    const stageDocumentContent = taskStore.documents.filter((document) => document.key === COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY).map((document) => document.content).join("\n");
    for (const document of taskStore.documents) {
      expect(document.content).toContain("draft");
      expect(document.content).toMatch(/not promoted for filing|do not provide legal advice/s);
      expect(document.content).toMatch(/citation[-\/]source verification|source\/citation verification|source-linked only/);
      expect(document.content).toMatch(/opposing-counsel[- ]red-team/);
      expect(document.content).toMatch(/lineage[- ]preservation/);
    }
    expect(allDocumentContent).toContain("All generated outputs are drafts only");
    expect(stageDocumentContent).toContain("Read task document key `vault-mining-receipts` as the required first source manifest");
    expect(stageDocumentContent).toContain("does not legally verify facts or validate citations");
    expect(stageDocumentContent).toContain("Read task document key `courtlistener-authority-validation` when present");
    expect(stageDocumentContent).toContain("Read task document key `research-memo` from the research-memo stage task");
    expect(stageDocumentContent).toContain("task document key `evidence-ledger` from the evidence-ledger stage task");
    expect(stageDocumentContent).toContain("task document key `claim-map` from the claim-map stage task");
    expect(stageDocumentContent).toContain("task document key `draft-counter-lawsuit-complaint`");
    expect(stageDocumentContent).toContain("draft-counter-lawsuit-complaint-status");
    expect(stageDocumentContent).toContain("draft-only artifact to attack");
    expect(stageDocumentContent).toContain("research-memo-status` blocked, partial, or failed entries as unresolved prerequisites");
    expect(stageDocumentContent).toContain("evidence-ledger-status` blocked, partial, failed, stale, or unresolved entries as unresolved prerequisites");
    expect(stageDocumentContent).toContain("`claim-map-status` reports blocked, partial, failed, stale, or unresolved prerequisites");
    expect(stageDocumentContent).toContain("Missing, unmatched, ambiguous, or unavailable CourtListener validation remains an unresolved authority gap");
    expect(stageDocumentContent).toContain("not good-law verification");
    expect(stageDocumentContent).toContain("not citation-format validation");
    expect(stageDocumentContent).toContain("not filing-ready");
    expect(stageDocumentContent).toContain("not verified facts");
    expect(stageDocumentContent).toContain("not human verification");
    expect(stageDocumentContent).toContain("not promoted for filing");
    for (const key of ["research-memo", "evidence-ledger", "claim-map", "draft-counter-lawsuit-complaint", "red-team-report", "lineage-scoring-log"]) {
      expect(stageDocumentContent).toContain(`Output document key: ${key}`);
    }
  });
});

describe("getCounterLawsuitWorkflowRunStatus", () => {
  it("derives run status from tasks with matching provenance", async () => {
    const taskStore = new FakeTaskStore();
    const agentStore = new FakeAgentStore();
    await startCounterLawsuitWorkflowRun({
      taskStore: taskStore as any,
      agentStore: agentStore as any,
      input: validInput(),
      generateRunId: () => "CLW-status",
    });
    taskStore.tasks[0] = { ...taskStore.tasks[0], column: "done" };
    taskStore.tasks[1] = { ...taskStore.tasks[1], column: "in-progress" };

    const status = await getCounterLawsuitWorkflowRunStatus({ taskStore: taskStore as any, runId: "CLW-status" });

    expect(status.status).toBe("running");
    expect(status.stageTasks).toHaveLength(6);
    expect(status.artifacts[0]).toMatchObject({ id: "research-memo", status: "ready", taskId: "FN-001" });
    expect(status.artifacts[1]).toMatchObject({ id: "evidence-ledger", status: "generating", taskId: "FN-002" });
    expect(status.lineageDocuments[0]).toEqual({ taskId: "FN-001", documentKey: COUNTER_LAWSUIT_RUN_DOCUMENT_KEY, stage: "research-memo" });
  });

  it("returns not found for unknown run IDs", async () => {
    const taskStore = new FakeTaskStore();

    await expect(getCounterLawsuitWorkflowRunStatus({ taskStore: taskStore as any, runId: "missing" })).rejects.toThrow("Legal workflow run missing not found");
  });
});
