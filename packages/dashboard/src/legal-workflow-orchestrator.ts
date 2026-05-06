import { createHash, randomUUID } from "node:crypto";
import type { Agent, AgentStore, Task, TaskStore, WorkflowStep } from "@fusion/core";
import { badRequest, notFound } from "./api-error.js";

export const COUNTER_LAWSUIT_WORKFLOW_KIND = "counter-lawsuit-prototype";
export const COUNTER_LAWSUIT_RUN_DOCUMENT_KEY = "counter-lawsuit-run";
export const COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY = "counter-lawsuit-stage";

export const DEFAULT_CODEX_LEGAL_SKILL_NAMES = [
  "legal-research",
  "legal-evidence-mining",
  "legal-drafting",
  "opposing-counsel-red-team",
] as const;

export const COUNTER_LAWSUIT_SAFETY_GATES = [
  "citation-source-verification",
  "opposing-counsel-red-team",
  "lineage-preservation",
] as const;

export type CounterLawsuitSafetyGate = typeof COUNTER_LAWSUIT_SAFETY_GATES[number];
export type CodexSkillSource = "default" | "user";
export type SourceScopeStatus = "specified" | "unspecified";

export interface CounterLawsuitWorkflowSafeguards {
  citationSourceVerification?: boolean;
  opposingCounselRedTeam?: boolean;
  preserveLineage?: boolean;
  humanVerificationRequired?: boolean;
}

export interface CounterLawsuitWorkflowLaunchInput {
  matterName?: unknown;
  focus?: unknown;
  vaultScope?: unknown;
  sourceScope?: unknown;
  sourceQuery?: unknown;
  requestedArtifacts?: unknown;
  safeguards?: CounterLawsuitWorkflowSafeguards;
  safetyAcknowledgments?: CounterLawsuitWorkflowSafeguards;
  codexSkillNames?: unknown;
}

export interface CounterLawsuitArtifactStatus {
  id: string;
  label: string;
  status: "queued" | "pending" | "generating" | "ready" | "failed";
  documentKey: string;
  taskId?: string;
}

export interface CounterLawsuitStageTaskSummary {
  id: string;
  title?: string;
  stage: string;
  stageIndex: number;
  expectedArtifact: string;
  documentKey: string;
  status: Task["column"];
  dependencies: string[];
  assignedAgentId?: string;
}

export interface CounterLawsuitWorkflowRunResponse {
  runId: string;
  status: "queued";
  taskId: string;
  task: Task;
  message: string;
  documentKey: typeof COUNTER_LAWSUIT_RUN_DOCUMENT_KEY;
  stageTasks: CounterLawsuitStageTaskSummary[];
  workflowStepIds: string[];
  agentIds: string[];
  artifactKeys: string[];
  artifacts: CounterLawsuitArtifactStatus[];
  safetyGates: CounterLawsuitSafetyGate[];
  sourceScopeStatus: SourceScopeStatus;
  codexSkillNames: string[];
  codexSkillSource: CodexSkillSource;
}

export interface CounterLawsuitRunStatusResponse {
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  stageTasks: CounterLawsuitStageTaskSummary[];
  artifacts: CounterLawsuitArtifactStatus[];
  artifactKeys: string[];
  safetyGates: CounterLawsuitSafetyGate[];
  sourceScopeStatus: SourceScopeStatus;
  lineageDocuments: Array<{ taskId: string; documentKey: string; stage: string }>;
}

interface StageDefinition {
  stage: string;
  title: string;
  legalWorkflowRole: string;
  expectedArtifact: string;
  artifactLabel: string;
  documentKey: string;
  promptPurpose: string;
}

export const COUNTER_LAWSUIT_STAGE_DEFINITIONS: StageDefinition[] = [
  {
    stage: "research-memo",
    title: "Counter-lawsuit research memo",
    legalWorkflowRole: "research-memo-writer",
    expectedArtifact: "research memo",
    artifactLabel: "Research memo",
    documentKey: "research-memo",
    promptPurpose: "prepare a draft research memo that identifies candidate counter-claims, governing law questions, and authority gaps",
  },
  {
    stage: "evidence-ledger",
    title: "Counter-lawsuit evidence ledger",
    legalWorkflowRole: "evidence-ledger-analyst",
    expectedArtifact: "evidence ledger",
    artifactLabel: "Evidence ledger",
    documentKey: "evidence-ledger",
    promptPurpose: "prepare a draft evidence ledger that maps factual assertions to source receipts and missing proof",
  },
  {
    stage: "claim-map",
    title: "Counter-lawsuit claim map",
    legalWorkflowRole: "claim-map-analyst",
    expectedArtifact: "claim map",
    artifactLabel: "Claim map",
    documentKey: "claim-map",
    promptPurpose: "prepare a draft claim map that links elements, facts, evidence, authorities, defenses, and open validation gaps",
  },
  {
    stage: "draft-counter-lawsuit-complaint",
    title: "Draft counter-lawsuit complaint",
    legalWorkflowRole: "legal-drafter",
    expectedArtifact: "draft counter-lawsuit complaint",
    artifactLabel: "Draft complaint",
    documentKey: "draft-counter-lawsuit-complaint",
    promptPurpose: "prepare a draft complaint scaffold for attorney review using only facts and authorities traceable to upstream documents",
  },
  {
    stage: "opposing-counsel-red-team-report",
    title: "Opposing-counsel red-team report",
    legalWorkflowRole: "opposing-counsel-red-team",
    expectedArtifact: "opposing-counsel red-team report",
    artifactLabel: "Opposing-counsel red-team report",
    documentKey: "red-team-report",
    promptPurpose: "prepare a draft adversarial critique that attacks the proposed claims, evidence, authorities, and complaint strategy",
  },
  {
    stage: "lineage-scoring-log",
    title: "Lineage and scoring log",
    legalWorkflowRole: "lineage-scoring-auditor",
    expectedArtifact: "lineage/scoring log",
    artifactLabel: "Lineage/scoring log",
    documentKey: "lineage-scoring-log",
    promptPurpose: "prepare a draft lineage and scoring log that records every source, verification state, red-team finding, and reliability limitation",
  },
];

const SAFETY_WORKFLOW_STEP_INPUTS = [
  {
    templateId: "counter-lawsuit-citation-source-verification",
    name: "Counter-lawsuit citation/source verification",
    description: "Requires source receipts and legal authority verification for legal workflow outputs.",
    prompt: `Review the task output for citation and source support. Check task document key research-memo for source-linked evidence, authority record IDs, unresolved gaps, and lineage when it exists. Check task document key research-memo-status and REQUEST REVISION if blockers are unresolved. Check task document key evidence-ledger for source-linked fact rows, preliminary claim links, confidence labels, citation status, unresolved gaps, and absence of positive promotion or filing-ready claims when it exists. Check task document key evidence-ledger-status and REQUEST REVISION if it reports blocked, partial, failed, stale, or unresolved prerequisites. Check task document key courtlistener-authority-validation when legal authorities are cited and the document exists. REQUEST REVISION if any factual claim, quotation, procedural assertion, or evidence reference lacks a source receipt. REQUEST REVISION if any cited legal authority is used as support without a matched CourtListener record when validation is available, or if missing, unmatched, ambiguous, or unavailable CourtListener results are presented as usable support. Do not pass unsupported facts, unverified authorities, invented citations, promoted authorities, or filing-ready language. Explicitly labeled unverified authority notes may remain only as unresolved research gaps; they do not satisfy this completion gate as support.`, 
  },
  {
    templateId: "counter-lawsuit-opposing-counsel-red-team",
    name: "Counter-lawsuit opposing-counsel red-team review",
    description: "Requires adversarial critique before legal workflow outputs can be treated as complete drafts.",
    prompt: `Review the task output for adversarial analysis. REQUEST REVISION if it lacks opposing-counsel critique, fails to identify weaknesses and defenses, overstates claim strength, or treats draft strategy as reliable without human legal review.`,
  },
  {
    templateId: "counter-lawsuit-lineage-preservation",
    name: "Counter-lawsuit lineage preservation",
    description: "Requires durable lineage for source, skill, stage, and artifact provenance.",
    prompt: `Review the task output for lineage preservation. REQUEST REVISION if upstream task IDs, artifact document keys, source scope status, Codex skill names, source receipts, red-team findings, or verification limitations are missing from the output.`,
  },
] as const;

type OrchestratorTaskStore = Pick<TaskStore, "createTask" | "upsertTaskDocument" | "listWorkflowSteps" | "createWorkflowStep" | "listTasks">;
type OrchestratorAgentStore = Pick<AgentStore, "listAgents" | "createAgent" | "updateAgent">;

export interface StartCounterLawsuitWorkflowRunOptions {
  taskStore: OrchestratorTaskStore;
  agentStore: OrchestratorAgentStore;
  input: unknown;
  now?: () => Date;
  generateRunId?: () => string;
}

export interface GetCounterLawsuitWorkflowRunStatusOptions {
  taskStore: OrchestratorTaskStore;
  runId: string;
}

interface NormalizedLaunchInput {
  matterName: string;
  focus?: string;
  vaultScope?: string;
  sourceScope?: string;
  sourceQuery?: string;
  requestedArtifacts: string[];
  codexSkillNames: string[];
  codexSkillSource: CodexSkillSource;
  sourceScopeStatus: SourceScopeStatus;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertSafetyAcknowledgment(safeguards: CounterLawsuitWorkflowSafeguards | undefined, key: keyof CounterLawsuitWorkflowSafeguards): void {
  if (safeguards?.[key] !== true) {
    throw badRequest(`safeguards.${key} must be true`);
  }
}

export function validateCounterLawsuitLaunchInput(input: unknown): NormalizedLaunchInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw badRequest("request body must be an object");
  }

  const launchInput = input as CounterLawsuitWorkflowLaunchInput;
  const matterName = normalizeOptionalString(launchInput.matterName);
  if (!matterName) {
    throw badRequest("matterName is required");
  }

  const safeguards = launchInput.safeguards ?? launchInput.safetyAcknowledgments;
  assertSafetyAcknowledgment(safeguards, "citationSourceVerification");
  assertSafetyAcknowledgment(safeguards, "opposingCounselRedTeam");
  assertSafetyAcknowledgment(safeguards, "preserveLineage");

  let codexSkillNames: string[];
  let codexSkillSource: CodexSkillSource = "default";
  if (launchInput.codexSkillNames === undefined) {
    codexSkillNames = [...DEFAULT_CODEX_LEGAL_SKILL_NAMES];
  } else {
    if (!Array.isArray(launchInput.codexSkillNames)) {
      throw badRequest("codexSkillNames must be an array of non-empty strings");
    }
    codexSkillNames = launchInput.codexSkillNames.map((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw badRequest("codexSkillNames must contain only non-empty strings");
      }
      return value.trim();
    });
    if (codexSkillNames.length === 0) {
      throw badRequest("codexSkillNames must contain at least one skill name when provided");
    }
    codexSkillSource = "user";
  }

  const requestedArtifacts = Array.isArray(launchInput.requestedArtifacts)
    ? launchInput.requestedArtifacts.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage) => stage.documentKey);

  const focus = normalizeOptionalString(launchInput.focus);
  const vaultScope = normalizeOptionalString(launchInput.vaultScope);
  const sourceScope = normalizeOptionalString(launchInput.sourceScope);
  const sourceQuery = normalizeOptionalString(launchInput.sourceQuery);
  const sourceScopeStatus: SourceScopeStatus = vaultScope || sourceScope || sourceQuery ? "specified" : "unspecified";

  return {
    matterName,
    focus,
    vaultScope,
    sourceScope,
    sourceQuery,
    requestedArtifacts,
    codexSkillNames,
    codexSkillSource,
    sourceScopeStatus,
  };
}

export function getCodexSkillSetKey(codexSkillNames: string[]): string {
  return createHash("sha256")
    .update(codexSkillNames.join("\u0000"))
    .digest("hex")
    .slice(0, 12);
}

function stringArrayEquals(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => typeof value === "string" && value === right[index]);
}

async function ensureLegalWorkflowAgents(agentStore: OrchestratorAgentStore, codexSkillNames: string[]): Promise<Record<string, Agent>> {
  const existingAgents = await agentStore.listAgents({ includeEphemeral: false });
  const result: Record<string, Agent> = {};
  const skillSetKey = getCodexSkillSetKey(codexSkillNames);

  for (const stage of COUNTER_LAWSUIT_STAGE_DEFINITIONS) {
    const name = `Legal workflow — ${COUNTER_LAWSUIT_WORKFLOW_KIND} — ${stage.legalWorkflowRole} — skills-${skillSetKey}`;
    const existing = existingAgents.find((agent) =>
      agent.name === name
      || (
        agent.metadata?.legalWorkflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
        && agent.metadata?.legalWorkflowRole === stage.legalWorkflowRole
        && agent.metadata?.codexSkillSetKey === skillSetKey
      )
    );
    const metadata = {
      ...(existing?.metadata ?? {}),
      legalWorkflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      legalWorkflowRole: stage.legalWorkflowRole,
      codexSkillSetKey: skillSetKey,
      skills: codexSkillNames,
    };

    if (existing) {
      const metadataMatches = existing.metadata?.legalWorkflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
        && existing.metadata?.legalWorkflowRole === stage.legalWorkflowRole
        && existing.metadata?.codexSkillSetKey === skillSetKey
        && stringArrayEquals(existing.metadata?.skills, codexSkillNames);
      result[stage.legalWorkflowRole] = metadataMatches
        ? existing
        : await agentStore.updateAgent(existing.id, { metadata });
      continue;
    }

    result[stage.legalWorkflowRole] = await agentStore.createAgent({
      name,
      role: "executor",
      title: `Legal workflow ${stage.expectedArtifact} agent`,
      icon: "scale",
      metadata,
      instructionsText: `Use installed Codex legal skills (${codexSkillNames.join(", ")}) for workflow execution. Do not provide legal advice. Mark unverified facts, citations, and integration results clearly.`,
    });
  }

  return result;
}

function isValidSafetyWorkflowStep(step: WorkflowStep, expectedPrompt: string): boolean {
  return step.mode === "prompt"
    && (step.phase ?? "pre-merge") === "pre-merge"
    && step.enabled === true
    && step.toolMode === "readonly"
    && typeof step.prompt === "string"
    && step.prompt.trim() === expectedPrompt.trim();
}

async function ensureSafetyWorkflowSteps(taskStore: OrchestratorTaskStore): Promise<WorkflowStep[]> {
  const existingSteps = await taskStore.listWorkflowSteps();
  const steps: WorkflowStep[] = [];

  for (const input of SAFETY_WORKFLOW_STEP_INPUTS) {
    const existing = existingSteps.find((step) =>
      (step.templateId === input.templateId || step.name.toLowerCase() === input.name.toLowerCase())
      && isValidSafetyWorkflowStep(step, input.prompt)
    );
    if (existing) {
      steps.push(existing);
      continue;
    }
    steps.push(await taskStore.createWorkflowStep({
      ...input,
      mode: "prompt",
      phase: "pre-merge",
      toolMode: "readonly",
      enabled: true,
      defaultOn: false,
    }));
  }

  return steps;
}

function buildSourceContext(normalized: NormalizedLaunchInput): string {
  const lines = [
    `Matter name: ${normalized.matterName}`,
    `Source scope status: ${normalized.sourceScopeStatus}`,
  ];
  if (normalized.focus) lines.push(`Focus: ${normalized.focus}`);
  if (normalized.vaultScope) lines.push(`Vault scope: ${normalized.vaultScope}`);
  if (normalized.sourceScope) lines.push(`Source scope: ${normalized.sourceScope}`);
  if (normalized.sourceQuery) lines.push(`Source query: ${normalized.sourceQuery}`);
  if (normalized.sourceScopeStatus === "unspecified") {
    lines.push("No source scope or query was supplied. Treat all source discovery as unverified until QMD MCP or Obsidian MCP mining supplies receipts.");
  }
  return lines.join("\n");
}

function buildStageDescription(params: {
  stage: StageDefinition;
  stageIndex: number;
  runId: string;
  normalized: NormalizedLaunchInput;
  upstreamStages: StageDefinition[];
  safetyStepIds: string[];
}): string {
  const { stage, stageIndex, runId, normalized, upstreamStages, safetyStepIds } = params;
  const upstreamText = upstreamStages.length > 0
    ? upstreamStages.map((upstream) => `- ${upstream.stage}: read task document key \`${upstream.documentKey}\`.`).join("\n")
    : "- None. This is the root research memo stage.";

  return `# Counter-lawsuit prototype stage: ${stage.expectedArtifact}

Run ID: ${runId}
Stage index: ${stageIndex}
Expected output document key: \`${stage.documentKey}\`

## Scope
${buildSourceContext(normalized)}

## Mission
Use the existing installed Codex legal skills assigned to this durable agent (${normalized.codexSkillNames.join(", ")}) to ${stage.promptPurpose}.

Do not embed, rewrite, or vendor Codex legal skill content in this task. Invoke the installed skills through the agent runtime skill-selection path.

## Integration handoff
${stage.stage === "research-memo" ? "Before drafting the research memo, read task document key `vault-mining-receipts` as the required first source manifest when it exists. Treat every vault-mining receipt as source-linked but unverified until later safety gates pass. Read task document key `courtlistener-authority-validation` when it exists, and treat `research-memo-status` blockers as unresolved prerequisites.\n\n" : stage.stage === "evidence-ledger" ? "Before drafting the evidence ledger, read task document key `research-memo` from the research-memo stage task when it exists. If task document key `research-memo-status` reports blocked, partial, or failed status, treat those entries as unresolved prerequisites rather than support. Do not depend on a pre-existing `evidence-ledger`; this stage creates it.\n\n" : "Before drafting this downstream artifact, read task document key `research-memo` from the research-memo stage task when it exists and read task document key `evidence-ledger` from the evidence-ledger stage task when it exists. If task document key `research-memo-status` or `evidence-ledger-status` reports blocked, partial, failed, stale, or unresolved prerequisites, treat those entries as unresolved prerequisites rather than support.\n\n"}Mine facts through QMD MCP and Obsidian MCP when those integrations are available. Read task document key \`courtlistener-authority-validation\` when it exists before relying on legal authorities or citations; the manifest is expected on the research-memo stage task after validation runs.

Treat missing, unmatched, ambiguous, or unavailable CourtListener results as unresolved authority gaps. The generated research memo is draft-only, source-linked only, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing. CourtListener lookup can identify a record or citation match, but it does not verify legal conclusions, good-law status, filing readiness, or attorney judgment.

If QMD MCP, Obsidian MCP, CourtListener, or any other integration is unavailable, explicitly mark the affected facts, evidence, authorities, or receipts as unverified. Do not invent citations, quotes, docket entries, CourtListener matches, or source receipts.

## Upstream dependencies
${upstreamText}

## Required output
Write the primary output to task document key \`${stage.documentKey}\`. The output must preserve source receipts, upstream task IDs, verification state, and unresolved gaps.

All generated materials are drafts only. They are not legal advice and are not promoted, reliable, or ready for use until citation/source verification, opposing-counsel red-team review, and lineage preservation gates pass, followed by qualified human review.

## Safety gates attached
${safetyStepIds.map((id) => `- ${id}`).join("\n")}

REQUEST REVISION is required if unsupported facts, unverified authorities, missing opposing-counsel critique, or missing lineage are found.`;
}

function buildStageDocument(params: {
  stage: StageDefinition;
  stageIndex: number;
  runId: string;
  normalized: NormalizedLaunchInput;
  upstreamTaskIds: string[];
  safetyStepIds: string[];
}): string {
  const { stage, stageIndex, runId, normalized, upstreamTaskIds, safetyStepIds } = params;
  return `# Counter-lawsuit stage provenance

- Workflow kind: ${COUNTER_LAWSUIT_WORKFLOW_KIND}
- Run ID: ${runId}
- Stage: ${stage.stage}
- Stage index: ${stageIndex}
- Expected artifact: ${stage.expectedArtifact}
- Output document key: ${stage.documentKey}
- Upstream task IDs: ${upstreamTaskIds.length > 0 ? upstreamTaskIds.join(", ") : "none"}
- Safety gates: ${COUNTER_LAWSUIT_SAFETY_GATES.join(", ")}
- Workflow step IDs: ${safetyStepIds.join(", ")}
- Codex skill names: ${normalized.codexSkillNames.join(", ")}
- Codex skill source: ${normalized.codexSkillSource}
- Source scope status: ${normalized.sourceScopeStatus}

## Stage prompt
${stage.promptPurpose}

## Integration expectations
${stage.stage === "research-memo" ? "Read task document key `vault-mining-receipts` as the required first source manifest when present. It contains source-linked receipts only; it does not legally verify facts or validate citations. Read task document key `courtlistener-authority-validation` when present. Treat task document key `research-memo-status` blockers as unresolved prerequisites.\n\n" : stage.stage === "evidence-ledger" ? "Read task document key `research-memo` from the research-memo stage task before creating the evidence ledger. Treat task document key `research-memo-status` blocked, partial, or failed entries as unresolved prerequisites, not support. Do not depend on a pre-existing task document key `evidence-ledger`; this stage creates it.\n\n" : "Read task document key `research-memo` from the research-memo stage task and task document key `evidence-ledger` from the evidence-ledger stage task before drafting this downstream artifact when they exist. Treat task document key `research-memo-status` or `evidence-ledger-status` blocked, partial, failed, stale, or unresolved entries as unresolved prerequisites, not support.\n\n"}Use existing installed Codex legal skills through assigned-agent metadata. Mine facts through QMD MCP and Obsidian MCP when available. Read task document key \`courtlistener-authority-validation\` when present before relying on authorities. Missing, unmatched, ambiguous, or unavailable CourtListener validation remains an unresolved authority gap; do not invent citations or CourtListener matches.

The generated research memo is draft-only, source-linked only, not legal advice, not good-law verification, not citation-format validation, not filing-ready, and not promoted for filing. CourtListener lookup evidence does not verify legal conclusions, good-law status, filing readiness, or attorney judgment.

## Safety boundary
Outputs are drafts only. They are not promoted or reliable until source/citation verification, opposing-counsel red-team review, lineage preservation, and qualified human verification pass.`;
}

function buildRunDocument(params: {
  runId: string;
  normalized: NormalizedLaunchInput;
  rootTaskId: string;
  stageTasks: CounterLawsuitStageTaskSummary[];
  safetyStepIds: string[];
  agentIds: string[];
  createdAt: string;
}): string {
  const { runId, normalized, rootTaskId, stageTasks, safetyStepIds, agentIds, createdAt } = params;
  return `# Counter-lawsuit workflow run

- Workflow kind: ${COUNTER_LAWSUIT_WORKFLOW_KIND}
- Run ID: ${runId}
- Created at: ${createdAt}
- Matter name: ${normalized.matterName}
- Root task ID: ${rootTaskId}
- Source scope status: ${normalized.sourceScopeStatus}
- Requested artifacts: ${normalized.requestedArtifacts.join(", ")}
- Codex skill names: ${normalized.codexSkillNames.join(", ")}
- Codex skill source: ${normalized.codexSkillSource}
- Safety gates: ${COUNTER_LAWSUIT_SAFETY_GATES.join(", ")}
- Workflow step IDs: ${safetyStepIds.join(", ")}
- Agent IDs: ${agentIds.join(", ")}

## Launch context
${buildSourceContext(normalized)}

## Stage DAG
${stageTasks.map((stage) => `${stage.stageIndex}. ${stage.stage} → ${stage.id} → \`${stage.documentKey}\``).join("\n")}

## Safety boundary
This server orchestration does not verify legal claims by itself. It only queues draft-producing tasks and attaches required safety workflow steps for later evidence, authority, red-team, lineage, and human verification.

All generated outputs are drafts only. They are not promoted, reliable, or ready for use until citation/source verification, opposing-counsel red-team review, lineage preservation, and qualified human verification pass.`;
}

function buildStageTaskSummary(task: Task, stage: StageDefinition, stageIndex: number): CounterLawsuitStageTaskSummary {
  return {
    id: task.id,
    title: task.title,
    stage: stage.stage,
    stageIndex,
    expectedArtifact: stage.expectedArtifact,
    documentKey: stage.documentKey,
    status: task.column,
    dependencies: task.dependencies,
    assignedAgentId: task.assignedAgentId,
  };
}

export async function startCounterLawsuitWorkflowRun(options: StartCounterLawsuitWorkflowRunOptions): Promise<CounterLawsuitWorkflowRunResponse> {
  const normalized = validateCounterLawsuitLaunchInput(options.input);
  const runId = options.generateRunId?.() ?? `CLW-${randomUUID()}`;
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const codexSkillSetKey = getCodexSkillSetKey(normalized.codexSkillNames);

  const agentsByRole = await ensureLegalWorkflowAgents(options.agentStore, normalized.codexSkillNames);
  const safetySteps = await ensureSafetyWorkflowSteps(options.taskStore);
  const safetyStepIds = safetySteps.map((step) => step.id);

  const tasks: Task[] = [];
  const stageSummaries: CounterLawsuitStageTaskSummary[] = [];

  for (let index = 0; index < COUNTER_LAWSUIT_STAGE_DEFINITIONS.length; index += 1) {
    const stage = COUNTER_LAWSUIT_STAGE_DEFINITIONS[index];
    const dependencies = tasks.length > 0 ? [tasks[tasks.length - 1].id] : [];
    const upstreamStages = COUNTER_LAWSUIT_STAGE_DEFINITIONS.slice(0, index);
    const assignedAgent = agentsByRole[stage.legalWorkflowRole];
    const sourceMetadata = {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: runId,
      workflowStage: stage.stage,
      workflowStageIndex: index,
      expectedArtifact: stage.expectedArtifact,
      documentKey: stage.documentKey,
      codexSkillNames: normalized.codexSkillNames,
      codexSkillSource: normalized.codexSkillSource,
      codexSkillSetKey,
      sourceScopeStatus: normalized.sourceScopeStatus,
      requiredSafetyGates: COUNTER_LAWSUIT_SAFETY_GATES,
      matterName: normalized.matterName,
    };

    const task = await options.taskStore.createTask({
      title: stage.title,
      description: buildStageDescription({
        stage,
        stageIndex: index,
        runId,
        normalized,
        upstreamStages,
        safetyStepIds,
      }),
      column: "todo",
      dependencies,
      enabledWorkflowSteps: safetyStepIds,
      assignedAgentId: assignedAgent.id,
      priority: "high",
      reviewLevel: 3,
      source: {
        sourceType: "dashboard_ui",
        sourceRunId: runId,
        sourceMetadata,
      },
    });

    tasks.push(task);
    const summary = buildStageTaskSummary(task, stage, index);
    stageSummaries.push(summary);

    await options.taskStore.upsertTaskDocument(task.id, {
      key: COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY,
      content: buildStageDocument({
        stage,
        stageIndex: index,
        runId,
        normalized,
        upstreamTaskIds: dependencies,
        safetyStepIds,
      }),
      author: "fusion-legal-workflow",
      metadata: sourceMetadata,
    });
  }

  const rootTask = tasks[0];
  const agentIds = Object.values(agentsByRole).map((agent) => agent.id);
  await options.taskStore.upsertTaskDocument(rootTask.id, {
    key: COUNTER_LAWSUIT_RUN_DOCUMENT_KEY,
    content: buildRunDocument({
      runId,
      normalized,
      rootTaskId: rootTask.id,
      stageTasks: stageSummaries,
      safetyStepIds,
      agentIds,
      createdAt,
    }),
    author: "fusion-legal-workflow",
    metadata: {
      workflowKind: COUNTER_LAWSUIT_WORKFLOW_KIND,
      workflowRunId: runId,
      codexSkillNames: normalized.codexSkillNames,
      codexSkillSource: normalized.codexSkillSource,
      codexSkillSetKey,
      sourceScopeStatus: normalized.sourceScopeStatus,
      safetyGates: COUNTER_LAWSUIT_SAFETY_GATES,
    },
  });

  const artifacts = COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage, index) => ({
    id: stage.documentKey,
    label: stage.artifactLabel,
    status: "queued" as const,
    documentKey: stage.documentKey,
    taskId: tasks[index].id,
  }));

  return {
    runId,
    status: "queued",
    taskId: rootTask.id,
    task: rootTask,
    message: "Counter-lawsuit prototype workflow queued with legal safety gates.",
    documentKey: COUNTER_LAWSUIT_RUN_DOCUMENT_KEY,
    stageTasks: stageSummaries,
    workflowStepIds: safetyStepIds,
    agentIds,
    artifactKeys: COUNTER_LAWSUIT_STAGE_DEFINITIONS.map((stage) => stage.documentKey),
    artifacts,
    safetyGates: [...COUNTER_LAWSUIT_SAFETY_GATES],
    sourceScopeStatus: normalized.sourceScopeStatus,
    codexSkillNames: normalized.codexSkillNames,
    codexSkillSource: normalized.codexSkillSource,
  };
}

function taskMatchesRun(task: Task, runId: string): boolean {
  return task.sourceMetadata?.workflowKind === COUNTER_LAWSUIT_WORKFLOW_KIND
    && task.sourceMetadata?.workflowRunId === runId;
}

function artifactStatusForColumn(column: Task["column"]): CounterLawsuitArtifactStatus["status"] {
  if (column === "done") return "ready";
  if (column === "in-progress" || column === "in-review") return "generating";
  if (column === "todo") return "queued";
  if (column === "triage") return "pending";
  return "failed";
}

function deriveOverallRunStatus(tasks: Task[]): CounterLawsuitRunStatusResponse["status"] {
  if (tasks.some((task) => task.status === "failed" || task.error || task.column === "archived")) return "failed";
  if (tasks.length > 0 && tasks.every((task) => task.column === "done")) return "completed";
  if (tasks.some((task) => task.column === "in-progress" || task.column === "in-review")) return "running";
  return "queued";
}

export async function getCounterLawsuitWorkflowRunStatus(options: GetCounterLawsuitWorkflowRunStatusOptions): Promise<CounterLawsuitRunStatusResponse> {
  const tasks = (await options.taskStore.listTasks({ includeArchived: true }))
    .filter((task) => taskMatchesRun(task, options.runId))
    .sort((left, right) => Number(left.sourceMetadata?.workflowStageIndex ?? 0) - Number(right.sourceMetadata?.workflowStageIndex ?? 0));

  if (tasks.length === 0) {
    throw notFound(`Legal workflow run ${options.runId} not found`);
  }

  const stageTasks = tasks.map((task) => {
    const stage = COUNTER_LAWSUIT_STAGE_DEFINITIONS.find((candidate) => candidate.stage === task.sourceMetadata?.workflowStage)
      ?? COUNTER_LAWSUIT_STAGE_DEFINITIONS[Number(task.sourceMetadata?.workflowStageIndex ?? 0)]
      ?? COUNTER_LAWSUIT_STAGE_DEFINITIONS[0];
    return buildStageTaskSummary(task, stage, Number(task.sourceMetadata?.workflowStageIndex ?? 0));
  });

  const sourceScopeStatus = (tasks[0].sourceMetadata?.sourceScopeStatus === "specified" ? "specified" : "unspecified") as SourceScopeStatus;
  const artifacts = stageTasks.map((stageTask) => ({
    id: stageTask.documentKey,
    label: COUNTER_LAWSUIT_STAGE_DEFINITIONS.find((stage) => stage.documentKey === stageTask.documentKey)?.artifactLabel ?? stageTask.expectedArtifact,
    status: artifactStatusForColumn(stageTask.status),
    documentKey: stageTask.documentKey,
    taskId: stageTask.id,
  }));

  return {
    runId: options.runId,
    status: deriveOverallRunStatus(tasks),
    stageTasks,
    artifacts,
    artifactKeys: stageTasks.map((stage) => stage.documentKey),
    safetyGates: [...COUNTER_LAWSUIT_SAFETY_GATES],
    sourceScopeStatus,
    lineageDocuments: stageTasks.map((stageTask) => ({
      taskId: stageTask.id,
      documentKey: stageTask.stage === "research-memo" ? COUNTER_LAWSUIT_RUN_DOCUMENT_KEY : COUNTER_LAWSUIT_STAGE_DOCUMENT_KEY,
      stage: stageTask.stage,
    })),
  };
}
