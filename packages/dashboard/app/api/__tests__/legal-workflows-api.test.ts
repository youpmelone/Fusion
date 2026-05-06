import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCounterLawsuitPrototypeWorkflowRunStatus,
  runCounterLawsuitPrototypeAuthorityValidation,
  runCounterLawsuitPrototypeClaimMap,
  runCounterLawsuitPrototypeDraftComplaint,
  runCounterLawsuitPrototypeEvidenceLedger,
  runCounterLawsuitPrototypeResearchMemo,
  runCounterLawsuitPrototypeRedTeamReport,
  runCounterLawsuitPrototypeVaultMining,
  startCounterLawsuitPrototypeWorkflow,
  type StartCounterLawsuitPrototypeWorkflowInput,
} from "../legacy";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

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
  it("starts a counter-lawsuit prototype run with project scoping and fixed safeguards", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "LWR-1",
          status: "queued",
          taskId: "FN-200",
          message: "Queued",
          artifacts: [{ id: "claim-map", label: "Claim map", status: "queued" }],
          vaultMining: { runId: "LWR-1", status: "partial", receiptCount: 0, providerDiagnostics: [], safetyNotice: "not legally verified" },
          authorityValidation: { runId: "LWR-1", status: "no-candidates", candidateCount: 0, validatedCount: 0, unmatchedCount: 0, diagnostics: [], safetyNotice: "not good-law verification" },
          researchMemo: { runId: "LWR-1", status: "blocked", evidenceCount: 0, authorityCount: 0, conclusionCount: 2, sourcePathCount: 0, diagnostics: [], safetyNotice: "draft-only" },
          evidenceLedger: { runId: "LWR-1", status: "blocked", factCount: 1, sourceLinkCount: 0, claimLinkCount: 1, unresolvedGapCount: 1, citationStatusCounts: { "source-linked-local-evidence": 0, "matched-courtlistener-lookup-record": 0, "unresolved-authority-lookup-record": 0, "missing-source-link": 1, "needs-human-citation-verification": 1 }, confidenceCounts: { high: 0, medium: 0, low: 0, unsupported: 1 }, diagnostics: [], safetyNotice: "draft-only ledger" },
          claimMap: { runId: "LWR-1", status: "blocked", claimCount: 1, elementCount: 1, allegationCount: 0, supportingEvidenceCount: 0, missingProofCount: 1, unresolvedGapCount: 1, diagnostics: [], safetyNotice: "draft-only claim map" },
          draftComplaint: { runId: "LWR-1", status: "blocked", draftComplaintDocumentKey: "draft-counter-lawsuit-complaint", sectionCount: 10, paragraphCount: 0, claimDraftCount: 0, sourceReferenceCount: 0, sourcePathCount: 0, missingProofCount: 1, unresolvedGapCount: 1, diagnostics: [], safetyNotice: "draft-only complaint" },
          redTeamReport: { runId: "LWR-1", status: "blocked", redTeamReportDocumentKey: "red-team-report", statusDocumentKey: "red-team-report-status", findingCount: 1, mtdAttackCount: 1, citationIssueCount: 1, revisionRecommendationCount: 1, unresolvedBlockerCount: 1, reviewedParagraphCount: 0, reviewedClaimCount: 0, diagnostics: [], safetyNotice: "draft-only red-team report" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await startCounterLawsuitPrototypeWorkflow(input, "proj/legal+workflow");

    expect(response.runId).toBe("LWR-1");
    expect(response.vaultMining?.status).toBe("partial");
    expect(response.authorityValidation?.status).toBe("no-candidates");
    expect(response.researchMemo?.status).toBe("blocked");
    expect(response.evidenceLedger?.status).toBe("blocked");
    expect(response.claimMap?.status).toBe("blocked");
    expect(response.draftComplaint?.status).toBe("blocked");
    expect(response.redTeamReport?.status).toBe("blocked");
    expect(response.redTeamReport?.redTeamReportDocumentKey).toBe("red-team-report");
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
          vaultMining: { runId: "CLW-1", status: "not-run", receiptCount: 0, providerDiagnostics: [], safetyNotice: "not promoted for filing" },
          authorityValidation: { runId: "CLW-1", status: "not-run", candidateCount: 0, validatedCount: 0, unmatchedCount: 0, diagnostics: [], safetyNotice: "not filing readiness" },
          researchMemo: { runId: "CLW-1", status: "not-run", evidenceCount: 0, authorityCount: 0, conclusionCount: 0, sourcePathCount: 0, diagnostics: [], safetyNotice: "draft-only" },
          evidenceLedger: { runId: "CLW-1", status: "not-run", factCount: 0, sourceLinkCount: 0, claimLinkCount: 0, unresolvedGapCount: 0, citationStatusCounts: { "source-linked-local-evidence": 0, "matched-courtlistener-lookup-record": 0, "unresolved-authority-lookup-record": 0, "missing-source-link": 0, "needs-human-citation-verification": 0 }, confidenceCounts: { high: 0, medium: 0, low: 0, unsupported: 0 }, diagnostics: [], safetyNotice: "draft-only ledger" },
          claimMap: { runId: "CLW-1", status: "not-run", claimCount: 0, elementCount: 0, allegationCount: 0, supportingEvidenceCount: 0, missingProofCount: 0, unresolvedGapCount: 0, diagnostics: [], safetyNotice: "draft-only claim map" },
          draftComplaint: { runId: "CLW-1", status: "not-run", sectionCount: 0, paragraphCount: 0, claimDraftCount: 0, sourceReferenceCount: 0, sourcePathCount: 0, missingProofCount: 0, unresolvedGapCount: 0, diagnostics: [], safetyNotice: "draft-only complaint" },
          redTeamReport: { runId: "CLW-1", status: "not-run", findingCount: 0, mtdAttackCount: 0, citationIssueCount: 0, revisionRecommendationCount: 0, unresolvedBlockerCount: 0, reviewedParagraphCount: 0, reviewedClaimCount: 0, diagnostics: [], safetyNotice: "draft-only red-team report" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await fetchCounterLawsuitPrototypeWorkflowRunStatus("CLW/1", "proj/legal+workflow");

    expect(response.status).toBe("running");
    expect(response.vaultMining?.status).toBe("not-run");
    expect(response.authorityValidation?.status).toBe("not-run");
    expect(response.researchMemo?.status).toBe("not-run");
    expect(response.evidenceLedger?.status).toBe("not-run");
    expect(response.claimMap?.status).toBe("not-run");
    expect(response.draftComplaint?.status).toBe("not-run");
    expect(response.redTeamReport?.status).toBe("not-run");
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
          safetyNotice: "not citation-validated",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await runCounterLawsuitPrototypeVaultMining("CLW/1", { queries: ["Acme"], qmd: { searchToolName: "qmd.search" } }, "proj/legal+workflow");

    expect(response.receiptCount).toBe(2);
    expect(response.safetyNotice).toContain("not citation-validated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/vault-mining?projectId=proj%2Flegal%2Bworkflow");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ queries: ["Acme"], qmd: { searchToolName: "qmd.search" } });
  });
});

it("retries counter-lawsuit authority validation with project scoping", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        runId: "CLW-1",
        status: "completed",
        researchRunId: "RR-CL",
        candidateCount: 1,
        validatedCount: 1,
        unmatchedCount: 0,
        diagnostics: [],
        authorityValidationDocumentKey: "courtlistener-authority-validation",
        statusDocumentKey: "courtlistener-status",
        safetyNotice: "not good-law verification",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const response = await runCounterLawsuitPrototypeAuthorityValidation("CLW/1", { citations: ["410 U.S. 113"], maxResultsPerCandidate: 1 }, "proj/legal+workflow");

  expect(response.validatedCount).toBe(1);
  expect(response.safetyNotice).toContain("not good-law verification");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/authority-validation?projectId=proj%2Flegal%2Bworkflow");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ citations: ["410 U.S. 113"], maxResultsPerCandidate: 1 });
});

it("retries counter-lawsuit research memo generation with project scoping", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        runId: "CLW-1",
        status: "completed",
        memoDocumentKey: "research-memo",
        statusDocumentKey: "research-memo-status",
        evidenceCount: 2,
        authorityCount: 1,
        conclusionCount: 3,
        sourcePathCount: 2,
        diagnostics: [],
        safetyNotice: "draft-only and not filing-ready",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const response = await runCounterLawsuitPrototypeResearchMemo("CLW/1", { force: true }, "proj/legal+workflow");

  expect(response.evidenceCount).toBe(2);
  expect(response.safetyNotice).toContain("not filing-ready");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/research-memo?projectId=proj%2Flegal%2Bworkflow");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ force: true });
});

it("retries counter-lawsuit evidence ledger generation with project scoping", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        runId: "CLW-1",
        status: "partial",
        ledgerDocumentKey: "evidence-ledger",
        statusDocumentKey: "evidence-ledger-status",
        factCount: 2,
        sourceLinkCount: 2,
        claimLinkCount: 2,
        unresolvedGapCount: 1,
        citationStatusCounts: { "source-linked-local-evidence": 2, "matched-courtlistener-lookup-record": 1, "unresolved-authority-lookup-record": 1, "missing-source-link": 0, "needs-human-citation-verification": 2 },
        confidenceCounts: { high: 1, medium: 0, low: 1, unsupported: 0 },
        diagnostics: [],
        safetyNotice: "draft-only and not filing-ready",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const response = await runCounterLawsuitPrototypeEvidenceLedger("CLW/1", { force: true }, "proj/legal+workflow");

  expect(response.factCount).toBe(2);
  expect(response.safetyNotice).toContain("not filing-ready");
  expect(response.citationStatusCounts["unresolved-authority-lookup-record"]).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/evidence-ledger?projectId=proj%2Flegal%2Bworkflow");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ force: true });
});

it("retries counter-lawsuit claim-map generation with project scoping", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        runId: "CLW-1",
        status: "partial",
        claimMapDocumentKey: "claim-map",
        statusDocumentKey: "claim-map-status",
        claimCount: 2,
        elementCount: 2,
        allegationCount: 2,
        supportingEvidenceCount: 2,
        missingProofCount: 3,
        unresolvedGapCount: 3,
        diagnostics: [],
        safetyNotice: "draft-only and not filing-ready",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const response = await runCounterLawsuitPrototypeClaimMap("CLW/1", { force: true }, "proj/legal+workflow");

  expect(response.claimCount).toBe(2);
  expect(response.safetyNotice).toContain("not filing-ready");
  expect(response.missingProofCount).toBe(3);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/claim-map?projectId=proj%2Flegal%2Bworkflow");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ force: true });
});


it("retries counter-lawsuit draft complaint generation with project scoping", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        runId: "CLW-1",
        status: "partial",
        draftComplaintDocumentKey: "draft-counter-lawsuit-complaint",
        statusDocumentKey: "draft-counter-lawsuit-complaint-status",
        sectionCount: 10,
        paragraphCount: 2,
        claimDraftCount: 1,
        sourceReferenceCount: 2,
        sourcePathCount: 2,
        missingProofCount: 1,
        unresolvedGapCount: 1,
        diagnostics: [],
        safetyNotice: "draft-only and not filing-ready",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const response = await runCounterLawsuitPrototypeDraftComplaint("CLW/1", { force: true }, "proj/legal+workflow");

  expect(response.paragraphCount).toBe(2);
  expect(response.draftComplaintDocumentKey).toBe("draft-counter-lawsuit-complaint");
  expect(response.safetyNotice).toContain("not filing-ready");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/draft-counter-lawsuit-complaint?projectId=proj%2Flegal%2Bworkflow");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ force: true });
});

it("retries counter-lawsuit red-team report generation with project scoping", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        runId: "CLW-1",
        status: "partial",
        redTeamReportDocumentKey: "red-team-report",
        statusDocumentKey: "red-team-report-status",
        findingCount: 2,
        mtdAttackCount: 1,
        citationIssueCount: 1,
        revisionRecommendationCount: 2,
        unresolvedBlockerCount: 1,
        reviewedParagraphCount: 3,
        reviewedClaimCount: 1,
        diagnostics: [],
        safetyNotice: "draft-only red-team report, not filing-ready, not reliable support",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const response = await runCounterLawsuitPrototypeRedTeamReport("CLW/1", { force: true }, "proj/legal+workflow");

  expect(response.redTeamReportDocumentKey).toBe("red-team-report");
  expect(response.mtdAttackCount).toBe(1);
  expect(response.safetyNotice).toContain("not reliable support");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/legal-workflows/counter-lawsuit/runs/CLW%2F1/red-team-report?projectId=proj%2Flegal%2Bworkflow");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ force: true });
});
