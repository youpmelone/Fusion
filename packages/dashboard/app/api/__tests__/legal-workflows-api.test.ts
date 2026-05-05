import { beforeEach, describe, expect, it, vi } from "vitest";
import { startCounterLawsuitPrototypeWorkflow, type StartCounterLawsuitPrototypeWorkflowInput } from "../legacy";

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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await startCounterLawsuitPrototypeWorkflow(input, "proj/legal+workflow");

    expect(response.runId).toBe("LWR-1");
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
});
