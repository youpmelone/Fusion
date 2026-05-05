import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCounterLawsuitPrototypeWorkflowRunStatus,
  runCounterLawsuitPrototypeVaultMining,
  startCounterLawsuitPrototypeWorkflow,
  type StartCounterLawsuitPrototypeWorkflowInput,
} from "../legacy";

const input: StartCounterLawsuitPrototypeWorkflowInput = {
  matterName: "Acme response matter",
  focus: "Retaliatory claims and filing timeline",
  vaultScope: "client/acme/litigation",
  requestedArtifacts: ["claim-map", "evidence-lineage", "draft-response"],
  safeguards: {
    citationSourceVerification: true,
    opposingCounselRedTeam: true,
    preserveLineage: true,
    humanVerificationRequired: true,
  },
};

describe("legal workflow API helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("starts a counter-lawsuit prototype run with project scoping and fixed safeguards", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "LWR-1",
          status: "queued",
          taskId: "FN-200",
          message: "Queued",
          artifacts: [{ id: "claim-map", label: "Claim map", status: "queued" }],
          vaultMining: { runId: "LWR-1", status: "partial", receiptCount: 0, providerDiagnostics: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await startCounterLawsuitPrototypeWorkflow(input, "proj/legal+workflow");

    expect(response.runId).toBe("LWR-1");
    expect(response.vaultMining?.status).toBe("partial");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs?projectId=proj%2Flegal%2Bworkflow");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(JSON.parse(String(init?.body)).safeguards).toEqual({
      citationSourceVerification: true,
      opposingCounselRedTeam: true,
      preserveLineage: true,
      humanVerificationRequired: true,
    });
  });

  it("fetches counter-lawsuit prototype run status with project scoping", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "CLW-1",
          status: "running",
          stageTasks: [],
          artifacts: [],
          artifactKeys: [],
          safetyGates: ["citation-source-verification"],
          sourceScopeStatus: "unspecified",
          lineageDocuments: [],
          vaultMining: { runId: "CLW-1", status: "not-run", receiptCount: 0, providerDiagnostics: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await fetchCounterLawsuitPrototypeWorkflowRunStatus("CLW/1", "proj/legal+workflow");

    expect(response.status).toBe("running");
    expect(response.vaultMining?.status).toBe("not-run");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1?projectId=proj%2Flegal%2Bworkflow");
    expect(init?.method).toBeUndefined();
  });

  it("retries counter-lawsuit vault mining with project scoping", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "CLW-1",
          status: "completed",
          researchRunId: "RR-1",
          receiptCount: 2,
          receiptsDocumentKey: "vault-mining-receipts",
          providerDiagnostics: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await runCounterLawsuitPrototypeVaultMining("CLW/1", { queries: ["Acme"], qmd: { searchToolName: "qmd.search" } }, "proj/legal+workflow");

    expect(response.receiptCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/vault-mining?projectId=proj%2Flegal%2Bworkflow");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ queries: ["Acme"], qmd: { searchToolName: "qmd.search" } });
  });
});
