import { AgentStore } from "@fusion/core";
import type { AgentStore as AgentStoreType, TaskStore } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import {
  getCounterLawsuitWorkflowRunStatus,
  startCounterLawsuitWorkflowRun,
  type CounterLawsuitWorkflowLaunchInput,
} from "../legal-workflow-orchestrator.js";
import {
  RESEARCH_MEMO_DOCUMENT_KEY,
  RESEARCH_MEMO_SAFETY_NOTICE,
  deriveResearchMemoStatusForRun,
  generateCounterLawsuitResearchMemo,
  type CounterLawsuitResearchMemoResult,
  type ResearchMemoDiagnostic,
} from "../legal-research-memo.js";
import {
  EVIDENCE_LEDGER_DOCUMENT_KEY,
  EVIDENCE_LEDGER_SAFETY_NOTICE,
  deriveEvidenceLedgerStatusForRun,
  generateCounterLawsuitEvidenceLedger,
  type CounterLawsuitEvidenceLedgerResult,
  type EvidenceLedgerDiagnostic,
  type EvidenceLedgerCitationStatusKind,
  type EvidenceLedgerConfidence,
} from "../legal-evidence-ledger.js";
import {
  CLAIM_MAP_DOCUMENT_KEY,
  CLAIM_MAP_SAFETY_NOTICE,
  deriveClaimMapStatusForRun,
  generateCounterLawsuitClaimMap,
  type ClaimMapDiagnostic,
  type CounterLawsuitClaimMapResult,
} from "../legal-claim-map.js";
import {
  DRAFT_COMPLAINT_DOCUMENT_KEY,
  DRAFT_COMPLAINT_SAFETY_NOTICE,
  deriveComplaintDraftStatusForRun,
  generateCounterLawsuitComplaintDraft,
  type ComplaintDraftDiagnostic,
  type CounterLawsuitComplaintDraftResult,
} from "../legal-complaint-draft.js";
import {
  COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
  COURTLISTENER_SAFETY_NOTICE,
  deriveAuthorityValidationStatusForRun,
  validateCounterLawsuitAuthorities,
  validateCourtListenerRetryRequest,
  type CourtListenerAuthorityValidationRequest,
  type CourtListenerAuthorityValidationResult,
  type CourtListenerClient,
  type CourtListenerProviderDiagnostic,
} from "../legal-courtlistener.js";
import {
  deriveVaultMiningStatusForRun,
  mineCounterLawsuitVaultSources,
  validateVaultMiningOverrides,
  VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
  VAULT_MINING_SAFETY_NOTICE,
  type LegalVaultMcpClientFactory,
  type VaultMiningProviderDiagnostic,
  type VaultMiningRequest,
  type VaultMiningResult,
} from "../legal-vault-mining.js";
import type { ApiRoutesContext } from "./types.js";

export interface LegalWorkflowRouteDeps {
  createAgentStore?: (store: TaskStore) => Promise<Pick<AgentStoreType, "listAgents" | "createAgent" | "updateAgent">> | Pick<AgentStoreType, "listAgents" | "createAgent" | "updateAgent">;
  mcpClientFactory?: LegalVaultMcpClientFactory;
  searchProjectMemoryFn?: Parameters<typeof mineCounterLawsuitVaultSources>[0]["searchProjectMemoryFn"];
  courtListenerClient?: CourtListenerClient;
  courtListenerClientFactory?: () => CourtListenerClient;
  now?: () => Date;
}

export interface LegalWorkflowVaultMiningSummary {
  runId: string;
  status: VaultMiningResult["status"] | "not-run";
  researchRunId?: string;
  receiptCount: number;
  receiptsDocumentKey?: string;
  statusDocumentKey?: string;
  providerDiagnostics: VaultMiningProviderDiagnostic[];
  safetyNotice: string;
}

export interface LegalWorkflowAuthorityValidationSummary {
  runId: string;
  status: CourtListenerAuthorityValidationResult["status"] | "not-run";
  researchRunId?: string;
  candidateCount: number;
  validatedCount: number;
  unmatchedCount: number;
  diagnostics: CourtListenerProviderDiagnostic[];
  authorityValidationDocumentKey?: string;
  statusDocumentKey?: string;
  safetyNotice: string;
}

export interface LegalWorkflowResearchMemoSummary {
  runId: string;
  status: CounterLawsuitResearchMemoResult["status"];
  memoDocumentKey?: string;
  statusDocumentKey?: string;
  evidenceCount: number;
  authorityCount: number;
  conclusionCount: number;
  sourcePathCount: number;
  diagnostics: ResearchMemoDiagnostic[];
  safetyNotice: string;
}

export interface LegalWorkflowEvidenceLedgerSummary {
  runId: string;
  status: CounterLawsuitEvidenceLedgerResult["status"];
  ledgerDocumentKey?: string;
  statusDocumentKey?: string;
  factCount: number;
  sourceLinkCount: number;
  claimLinkCount: number;
  unresolvedGapCount: number;
  citationStatusCounts: Record<EvidenceLedgerCitationStatusKind, number>;
  confidenceCounts: Record<EvidenceLedgerConfidence, number>;
  diagnostics: EvidenceLedgerDiagnostic[];
  safetyNotice: string;
}

export interface LegalWorkflowClaimMapSummary {
  runId: string;
  status: CounterLawsuitClaimMapResult["status"];
  claimMapDocumentKey?: string;
  statusDocumentKey?: string;
  claimCount: number;
  elementCount: number;
  allegationCount: number;
  supportingEvidenceCount: number;
  missingProofCount: number;
  unresolvedGapCount: number;
  diagnostics: ClaimMapDiagnostic[];
  safetyNotice: string;
}

export interface LegalWorkflowComplaintDraftSummary {
  runId: string;
  status: CounterLawsuitComplaintDraftResult["status"];
  draftComplaintDocumentKey?: string;
  statusDocumentKey?: string;
  sectionCount: number;
  paragraphCount: number;
  claimDraftCount: number;
  sourceReferenceCount: number;
  sourcePathCount: number;
  missingProofCount: number;
  unresolvedGapCount: number;
  diagnostics: ComplaintDraftDiagnostic[];
  safetyNotice: string;
}

function getTaskStoreFusionDir(store: TaskStore): string {
  const candidate = store as TaskStore & { getFusionDir?: () => string; getRootDir?: () => string };
  if (typeof candidate.getFusionDir === "function") {
    return candidate.getFusionDir();
  }
  if (typeof candidate.getRootDir === "function") {
    return `${candidate.getRootDir()}/.fusion`;
  }
  return ".fusion";
}

async function defaultCreateAgentStore(store: TaskStore): Promise<Pick<AgentStoreType, "listAgents" | "createAgent" | "updateAgent">> {
  const agentStore = new AgentStore({ rootDir: getTaskStoreFusionDir(store), taskStore: store });
  await agentStore.init();
  return agentStore;
}

function validateVaultMiningRunPayload(body: unknown): Partial<VaultMiningRequest> {
  if (body === undefined || body === null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length === 0)) {
    return {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("vault mining request body must be an object");
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["queries", "maxQueries", "maxResultsPerProvider", "qmd", "obsidian"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw badRequest(`invalid vault mining field: ${key}`);
  }
  if (record.queries !== undefined) {
    if (!Array.isArray(record.queries)) throw badRequest("queries must be an array of non-empty strings");
    for (const query of record.queries) {
      if (typeof query !== "string" || !query.trim()) throw badRequest("queries must contain only non-empty strings");
    }
  }
  const maxBounds = { maxQueries: 10, maxResultsPerProvider: 20 } as const;
  for (const key of ["maxQueries", "maxResultsPerProvider"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isInteger(record[key]) || record[key] < 1 || record[key] > maxBounds[key])) {
      throw badRequest(`${key} must be an integer between 1 and ${maxBounds[key]}`);
    }
  }
  return {
    queries: record.queries as string[] | undefined,
    maxQueries: record.maxQueries as number | undefined,
    maxResultsPerProvider: record.maxResultsPerProvider as number | undefined,
    providerOverrides: validateVaultMiningOverrides({ qmd: record.qmd, obsidian: record.obsidian }),
  };
}

function vaultMiningFailureSummary(runId: string): LegalWorkflowVaultMiningSummary {
  return {
    runId,
    status: "failed",
    receiptCount: 0,
    receiptsDocumentKey: VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
    providerDiagnostics: [{
      providerName: "vault-mining",
      status: "error",
      message: "Vault mining failed before receipts were persisted. Stage tasks remain queued; retry the vault-mining endpoint after checking MCP configuration.",
    }],
    safetyNotice: VAULT_MINING_SAFETY_NOTICE,
  };
}

async function runVaultMiningForResponse(params: {
  store: TaskStore;
  runId: string;
  launchInput?: CounterLawsuitWorkflowLaunchInput;
  request?: Partial<VaultMiningRequest>;
  deps: LegalWorkflowRouteDeps;
}): Promise<LegalWorkflowVaultMiningSummary> {
  try {
    const result = await mineCounterLawsuitVaultSources({
      taskStore: params.store,
      runId: params.runId,
      launchInput: params.launchInput,
      request: params.request,
      mcpClientFactory: params.deps.mcpClientFactory,
      searchProjectMemoryFn: params.deps.searchProjectMemoryFn,
      now: params.deps.now,
    });
    return {
      runId: result.runId,
      status: result.status,
      researchRunId: result.researchRunId,
      receiptCount: result.receiptCount,
      receiptsDocumentKey: result.receiptsDocumentKey,
      statusDocumentKey: result.statusDocumentKey,
      providerDiagnostics: result.providerDiagnostics,
      safetyNotice: result.safetyNotice,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw error;
    return vaultMiningFailureSummary(params.runId);
  }
}

function authorityValidationFailureSummary(runId: string): LegalWorkflowAuthorityValidationSummary {
  return {
    runId,
    status: "failed",
    candidateCount: 0,
    validatedCount: 0,
    unmatchedCount: 0,
    authorityValidationDocumentKey: COURTLISTENER_AUTHORITY_VALIDATION_DOCUMENT_KEY,
    diagnostics: [{
      providerName: "courtlistener",
      status: "error",
      message: "CourtListener authority validation failed before results were persisted. Stage tasks remain queued; retry the authority-validation endpoint after checking provider availability.",
    }],
    safetyNotice: COURTLISTENER_SAFETY_NOTICE,
  };
}

async function runAuthorityValidationForResponse(params: {
  store: TaskStore;
  runId: string;
  launchInput?: CounterLawsuitWorkflowLaunchInput;
  request?: Partial<CourtListenerAuthorityValidationRequest>;
  deps: LegalWorkflowRouteDeps;
}): Promise<LegalWorkflowAuthorityValidationSummary> {
  try {
    const result = await validateCounterLawsuitAuthorities({
      taskStore: params.store,
      runId: params.runId,
      launchInput: params.launchInput,
      request: params.request,
      client: params.deps.courtListenerClient,
      clientFactory: params.deps.courtListenerClientFactory,
      now: params.deps.now,
    });
    return {
      runId: result.runId ?? params.runId,
      status: result.status,
      researchRunId: result.researchRunId,
      candidateCount: result.candidateCount,
      validatedCount: result.validatedCount,
      unmatchedCount: result.unmatchedCount,
      diagnostics: result.diagnostics,
      authorityValidationDocumentKey: result.authorityValidationDocumentKey,
      statusDocumentKey: result.statusDocumentKey,
      safetyNotice: result.safetyNotice,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw error;
    return authorityValidationFailureSummary(params.runId);
  }
}

function researchMemoFailureSummary(runId: string): LegalWorkflowResearchMemoSummary {
  return {
    runId,
    status: "failed",
    memoDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
    evidenceCount: 0,
    authorityCount: 0,
    conclusionCount: 0,
    sourcePathCount: 0,
    diagnostics: [{
      code: "research-memo-route-failed",
      severity: "error",
      message: "Research memo generation failed before a memo summary could be returned. The workflow run remains queued; retry the research-memo endpoint after checking prerequisite documents.",
      sourceDocumentKey: RESEARCH_MEMO_DOCUMENT_KEY,
    }],
    safetyNotice: RESEARCH_MEMO_SAFETY_NOTICE,
  };
}

async function runResearchMemoForResponse(params: {
  store: TaskStore;
  runId: string;
  force?: boolean;
  deps: LegalWorkflowRouteDeps;
}): Promise<LegalWorkflowResearchMemoSummary> {
  try {
    const result = await generateCounterLawsuitResearchMemo({
      taskStore: params.store,
      runId: params.runId,
      force: params.force,
      now: params.deps.now,
    });
    return {
      runId: result.runId,
      status: result.status,
      memoDocumentKey: result.memoDocumentKey,
      statusDocumentKey: result.statusDocumentKey,
      evidenceCount: result.evidenceCount,
      authorityCount: result.authorityCount,
      conclusionCount: result.conclusionCount,
      sourcePathCount: result.sourcePathCount,
      diagnostics: result.diagnostics,
      safetyNotice: result.safetyNotice,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw error;
    return researchMemoFailureSummary(params.runId);
  }
}

function evidenceLedgerFailureSummary(runId: string): LegalWorkflowEvidenceLedgerSummary {
  return {
    runId,
    status: "failed",
    ledgerDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
    factCount: 0,
    sourceLinkCount: 0,
    claimLinkCount: 0,
    unresolvedGapCount: 0,
    citationStatusCounts: {
      "source-linked-local-evidence": 0,
      "matched-courtlistener-lookup-record": 0,
      "unresolved-authority-lookup-record": 0,
      "missing-source-link": 0,
      "needs-human-citation-verification": 0,
    },
    confidenceCounts: { high: 0, medium: 0, low: 0, unsupported: 0 },
    diagnostics: [{
      code: "evidence-ledger-route-failed",
      severity: "error",
      message: "Evidence ledger generation failed before a ledger summary could be returned. The workflow run remains queued; retry the evidence-ledger endpoint after checking prerequisite documents.",
      sourceDocumentKey: EVIDENCE_LEDGER_DOCUMENT_KEY,
    }],
    safetyNotice: EVIDENCE_LEDGER_SAFETY_NOTICE,
  };
}

async function runEvidenceLedgerForResponse(params: {
  store: TaskStore;
  runId: string;
  force?: boolean;
  deps: LegalWorkflowRouteDeps;
}): Promise<LegalWorkflowEvidenceLedgerSummary> {
  try {
    const result = await generateCounterLawsuitEvidenceLedger({
      taskStore: params.store,
      runId: params.runId,
      force: params.force,
      now: params.deps.now,
    });
    return {
      runId: result.runId,
      status: result.status,
      ledgerDocumentKey: result.ledgerDocumentKey,
      statusDocumentKey: result.statusDocumentKey,
      factCount: result.counts.facts,
      sourceLinkCount: result.counts.sourceLinks,
      claimLinkCount: result.counts.claimLinks,
      unresolvedGapCount: result.counts.unresolvedGaps,
      citationStatusCounts: result.counts.citationStatuses,
      confidenceCounts: result.counts.confidence,
      diagnostics: result.diagnostics,
      safetyNotice: result.safetyNotice,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw error;
    return evidenceLedgerFailureSummary(params.runId);
  }
}

function validateForceOnlyPayload(body: unknown, artifactName: string): { force?: boolean } {
  if (body === undefined || body === null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length === 0)) {
    return {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(`${artifactName} request body must be an object`);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "force") throw badRequest(`invalid ${artifactName} field: ${key}`);
  }
  if (record.force !== undefined && typeof record.force !== "boolean") {
    throw badRequest("force must be a boolean");
  }
  return { force: record.force as boolean | undefined };
}

function validateResearchMemoRetryPayload(body: unknown): { force?: boolean } {
  return validateForceOnlyPayload(body, "research memo");
}

function validateEvidenceLedgerRetryPayload(body: unknown): { force?: boolean } {
  return validateForceOnlyPayload(body, "evidence ledger");
}

function claimMapFailureSummary(runId: string): LegalWorkflowClaimMapSummary {
  return {
    runId,
    status: "failed",
    claimMapDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
    claimCount: 0,
    elementCount: 0,
    allegationCount: 0,
    supportingEvidenceCount: 0,
    missingProofCount: 0,
    unresolvedGapCount: 0,
    diagnostics: [{
      code: "claim-map-route-failed",
      severity: "error",
      message: "Claim map generation failed before a claim-map summary could be returned. The workflow run remains queued; retry the claim-map endpoint after checking prerequisite documents.",
      sourceDocumentKey: CLAIM_MAP_DOCUMENT_KEY,
    }],
    safetyNotice: CLAIM_MAP_SAFETY_NOTICE,
  };
}

async function runClaimMapForResponse(params: {
  store: TaskStore;
  runId: string;
  force?: boolean;
  deps: LegalWorkflowRouteDeps;
}): Promise<LegalWorkflowClaimMapSummary> {
  try {
    const result = await generateCounterLawsuitClaimMap({
      taskStore: params.store,
      runId: params.runId,
      force: params.force,
      now: params.deps.now,
    });
    return {
      runId: result.runId,
      status: result.status,
      claimMapDocumentKey: result.claimMapDocumentKey,
      statusDocumentKey: result.statusDocumentKey,
      claimCount: result.counts.claims,
      elementCount: result.counts.elements,
      allegationCount: result.counts.allegations,
      supportingEvidenceCount: result.counts.supportingEvidence,
      missingProofCount: result.counts.missingProof,
      unresolvedGapCount: result.counts.unresolvedGaps,
      diagnostics: result.diagnostics,
      safetyNotice: result.safetyNotice,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw error;
    return claimMapFailureSummary(params.runId);
  }
}

function validateClaimMapRetryPayload(body: unknown): { force?: boolean } {
  return validateForceOnlyPayload(body, "claim map");
}

function complaintDraftFailureSummary(runId: string): LegalWorkflowComplaintDraftSummary {
  return {
    runId,
    status: "failed",
    draftComplaintDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    sectionCount: 0,
    paragraphCount: 0,
    claimDraftCount: 0,
    sourceReferenceCount: 0,
    sourcePathCount: 0,
    missingProofCount: 0,
    unresolvedGapCount: 0,
    diagnostics: [{
      code: "draft-complaint-route-failed",
      severity: "error",
      message: "Draft complaint generation failed before a complaint summary could be returned. The workflow run remains queued; retry the draft-counter-lawsuit-complaint endpoint after checking prerequisite documents.",
      sourceDocumentKey: DRAFT_COMPLAINT_DOCUMENT_KEY,
    }],
    safetyNotice: DRAFT_COMPLAINT_SAFETY_NOTICE,
  };
}

async function runComplaintDraftForResponse(params: {
  store: TaskStore;
  runId: string;
  force?: boolean;
  deps: LegalWorkflowRouteDeps;
}): Promise<LegalWorkflowComplaintDraftSummary> {
  try {
    const result = await generateCounterLawsuitComplaintDraft({
      taskStore: params.store,
      runId: params.runId,
      force: params.force,
      now: params.deps.now,
    });
    return {
      runId: result.runId,
      status: result.status,
      draftComplaintDocumentKey: result.draftComplaintDocumentKey,
      statusDocumentKey: result.statusDocumentKey,
      sectionCount: result.counts.sections,
      paragraphCount: result.counts.paragraphs,
      claimDraftCount: result.counts.claimDrafts,
      sourceReferenceCount: result.counts.sourceReferences,
      sourcePathCount: result.counts.sourcePaths,
      missingProofCount: result.counts.missingProof,
      unresolvedGapCount: result.counts.unresolvedGaps,
      diagnostics: result.diagnostics,
      safetyNotice: result.safetyNotice,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw error;
    return complaintDraftFailureSummary(params.runId);
  }
}

function validateComplaintDraftRetryPayload(body: unknown): { force?: boolean } {
  return validateForceOnlyPayload(body, "draft complaint");
}

export function registerLegalWorkflowRoutes(ctx: ApiRoutesContext, deps: LegalWorkflowRouteDeps = {}): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;
  const createAgentStore = deps.createAgentStore ?? defaultCreateAgentStore;

  router.post("/legal-workflows/counter-lawsuit/runs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const response = await startCounterLawsuitWorkflowRun({
        taskStore: scopedStore,
        agentStore: await createAgentStore(scopedStore),
        input: req.body as CounterLawsuitWorkflowLaunchInput,
      });
      const vaultMining = await runVaultMiningForResponse({
        store: scopedStore,
        runId: response.runId,
        launchInput: req.body as CounterLawsuitWorkflowLaunchInput,
        deps,
      });
      const authorityValidation = await runAuthorityValidationForResponse({
        store: scopedStore,
        runId: response.runId,
        launchInput: req.body as CounterLawsuitWorkflowLaunchInput,
        deps,
      });
      const researchMemo = await runResearchMemoForResponse({
        store: scopedStore,
        runId: response.runId,
        deps,
      });
      const evidenceLedger = await runEvidenceLedgerForResponse({
        store: scopedStore,
        runId: response.runId,
        deps,
      });
      const claimMap = await runClaimMapForResponse({
        store: scopedStore,
        runId: response.runId,
        deps,
      });
      const draftComplaint = await runComplaintDraftForResponse({
        store: scopedStore,
        runId: response.runId,
        deps,
      });
      res.status(201).json({ ...response, vaultMining, authorityValidation, researchMemo, evidenceLedger, claimMap, draftComplaint });
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/legal-workflows/counter-lawsuit/runs/:runId/vault-mining", async (req, res) => {
    try {
      if (!req.params.runId?.trim()) throw badRequest("runId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const request = validateVaultMiningRunPayload(req.body);
      await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const vaultMining = await runVaultMiningForResponse({
        store: scopedStore,
        runId: req.params.runId,
        request,
        deps,
      });
      res.json(vaultMining);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/legal-workflows/counter-lawsuit/runs/:runId/authority-validation", async (req, res) => {
    try {
      if (!req.params.runId?.trim()) throw badRequest("runId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const request = validateCourtListenerRetryRequest(req.body);
      await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const authorityValidation = await runAuthorityValidationForResponse({
        store: scopedStore,
        runId: req.params.runId,
        request,
        deps,
      });
      res.json(authorityValidation);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/legal-workflows/counter-lawsuit/runs/:runId/research-memo", async (req, res) => {
    try {
      if (!req.params.runId?.trim()) throw badRequest("runId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const request = validateResearchMemoRetryPayload(req.body);
      await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const researchMemo = await runResearchMemoForResponse({
        store: scopedStore,
        runId: req.params.runId,
        force: request.force,
        deps,
      });
      res.json(researchMemo);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/legal-workflows/counter-lawsuit/runs/:runId/evidence-ledger", async (req, res) => {
    try {
      if (!req.params.runId?.trim()) throw badRequest("runId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const request = validateEvidenceLedgerRetryPayload(req.body);
      await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const evidenceLedger = await runEvidenceLedgerForResponse({
        store: scopedStore,
        runId: req.params.runId,
        force: request.force,
        deps,
      });
      res.json(evidenceLedger);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/legal-workflows/counter-lawsuit/runs/:runId/claim-map", async (req, res) => {
    try {
      if (!req.params.runId?.trim()) throw badRequest("runId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const request = validateClaimMapRetryPayload(req.body);
      await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const claimMap = await runClaimMapForResponse({
        store: scopedStore,
        runId: req.params.runId,
        force: request.force,
        deps,
      });
      res.json(claimMap);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/legal-workflows/counter-lawsuit/runs/:runId/draft-counter-lawsuit-complaint", async (req, res) => {
    try {
      if (!req.params.runId?.trim()) throw badRequest("runId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const request = validateComplaintDraftRetryPayload(req.body);
      await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const draftComplaint = await runComplaintDraftForResponse({
        store: scopedStore,
        runId: req.params.runId,
        force: request.force,
        deps,
      });
      res.json(draftComplaint);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.get("/legal-workflows/counter-lawsuit/runs/:runId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const status = await getCounterLawsuitWorkflowRunStatus({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const vaultMining = await deriveVaultMiningStatusForRun({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const authorityValidation = await deriveAuthorityValidationStatusForRun({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const researchMemo = await deriveResearchMemoStatusForRun({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const evidenceLedger = await deriveEvidenceLedgerStatusForRun({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const claimMap = await deriveClaimMapStatusForRun({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      const draftComplaint = await deriveComplaintDraftStatusForRun({
        taskStore: scopedStore,
        runId: req.params.runId,
      });
      res.json({ ...status, vaultMining, authorityValidation, researchMemo, evidenceLedger, claimMap, draftComplaint });
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });
}
