import { AgentStore } from "@fusion/core";
import type { AgentStore as AgentStoreType, TaskStore } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import {
  getCounterLawsuitWorkflowRunStatus,
  startCounterLawsuitWorkflowRun,
  type CounterLawsuitWorkflowLaunchInput,
} from "../legal-workflow-orchestrator.js";
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
      res.status(201).json({ ...response, vaultMining, authorityValidation });
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
      res.json({ ...status, vaultMining, authorityValidation });
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });
}
