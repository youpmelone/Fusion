import { AgentStore } from "@fusion/core";
import type { AgentStore as AgentStoreType, TaskStore } from "@fusion/core";
import { ApiError } from "../api-error.js";
import {
  getCounterLawsuitWorkflowRunStatus,
  startCounterLawsuitWorkflowRun,
  type CounterLawsuitWorkflowLaunchInput,
} from "../legal-workflow-orchestrator.js";
import type { ApiRoutesContext } from "./types.js";

export interface LegalWorkflowRouteDeps {
  createAgentStore?: (store: TaskStore) => Promise<Pick<AgentStoreType, "listAgents" | "createAgent" | "updateAgent">> | Pick<AgentStoreType, "listAgents" | "createAgent" | "updateAgent">;
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
      res.status(201).json(response);
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
      res.json(status);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });
}
