import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CounterLawsuitWorkflowView } from "../CounterLawsuitWorkflowView";
import { startCounterLawsuitPrototypeWorkflow } from "../../api";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    startCounterLawsuitPrototypeWorkflow: vi.fn(),
  };
});

const mockStartCounterLawsuitPrototypeWorkflow = vi.mocked(startCounterLawsuitPrototypeWorkflow);

describe("CounterLawsuitWorkflowView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the prototype overview, safety boundaries, and expected artifacts", () => {
    render(<CounterLawsuitWorkflowView />);

    expect(screen.getByRole("heading", { name: "Counter-lawsuit prototype" })).toBeInTheDocument();
    expect(screen.getAllByText(/generated materials are not legal advice/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Mandatory safety boundaries" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Citation/source verification" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Opposing-counsel red team" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lineage preservation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Human verification required" })).toBeInTheDocument();
    expect(screen.getByText("Research memo")).toBeInTheDocument();
    expect(screen.getByText("Evidence ledger")).toBeInTheDocument();
    expect(screen.getByText("Claim map")).toBeInTheDocument();
    expect(screen.getByText("Draft counter-lawsuit complaint")).toBeInTheDocument();
    expect(screen.getByText("Opposing-counsel red-team report")).toBeInTheDocument();
    expect(screen.getByText("Lineage/scoring log")).toBeInTheDocument();
  });

  it("shows an accessible validation error when the matter name is missing", async () => {
    const user = userEvent.setup();
    render(<CounterLawsuitWorkflowView />);

    await user.click(screen.getByRole("button", { name: /queue prototype run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a matter or workflow name");
    expect(screen.getByLabelText("Matter or workflow name")).toHaveAttribute("aria-invalid", "true");
    expect(mockStartCounterLawsuitPrototypeWorkflow).not.toHaveBeenCalled();
  });

  it("submits the fixed safeguards and launch context", async () => {
    const user = userEvent.setup();
    mockStartCounterLawsuitPrototypeWorkflow.mockResolvedValue({
      runId: "LWR-123",
      status: "queued",
      taskId: "FN-222",
      message: "Run accepted",
      artifacts: [{ id: "claim-map", label: "Claim map", status: "queued" }],
    });

    render(<CounterLawsuitWorkflowView projectId="proj_123" />);

    await user.type(screen.getByLabelText("Matter or workflow name"), "Acme response matter");
    await user.type(screen.getByLabelText("Optional focus"), "Retaliation timeline");
    await user.type(screen.getByLabelText("Optional vault scope"), "vault/acme");
    await user.click(screen.getByRole("button", { name: /queue prototype run/i }));

    await waitFor(() => expect(mockStartCounterLawsuitPrototypeWorkflow).toHaveBeenCalledTimes(1));
    expect(mockStartCounterLawsuitPrototypeWorkflow).toHaveBeenCalledWith(
      {
        matterName: "Acme response matter",
        focus: "Retaliation timeline",
        vaultScope: "vault/acme",
        requestedArtifacts: [
          "research-memo",
          "evidence-ledger",
          "claim-map",
          "draft-counter-lawsuit-complaint",
          "red-team-report",
          "lineage-scoring-log",
        ],
        safeguards: {
          citationSourceVerification: true,
          opposingCounselRedTeam: true,
          preserveLineage: true,
          humanVerificationRequired: true,
        },
      },
      "proj_123",
    );
  });

  it("disables the primary action while submitting", async () => {
    const user = userEvent.setup();
    let resolveRun: (value: Awaited<ReturnType<typeof startCounterLawsuitPrototypeWorkflow>>) => void = () => undefined;
    mockStartCounterLawsuitPrototypeWorkflow.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );

    render(<CounterLawsuitWorkflowView />);

    await user.type(screen.getByLabelText("Matter or workflow name"), "Acme matter");
    await user.click(screen.getByRole("button", { name: /queue prototype run/i }));

    const loadingButton = screen.getByRole("button", { name: /queueing prototype/i });
    expect(loadingButton).toBeDisabled();

    resolveRun({ runId: "LWR-1", status: "queued", artifacts: [] });
    await waitFor(() => expect(screen.getByRole("button", { name: /queue prototype run/i })).not.toBeDisabled());
  });

  it("renders the queued run, optional task, and returned artifact statuses", async () => {
    const user = userEvent.setup();
    mockStartCounterLawsuitPrototypeWorkflow.mockResolvedValue({
      runId: "LWR-123",
      status: "queued",
      taskId: "FN-222",
      message: "Run accepted",
      artifacts: [
        { id: "claim-map", label: "Claim map", status: "queued" },
        { id: "red-team-report", label: "Opposing-counsel red-team report", status: "pending" },
      ],
    });

    render(<CounterLawsuitWorkflowView addToast={vi.fn()} />);

    await user.type(screen.getByLabelText("Matter or workflow name"), "Acme matter");
    await user.click(screen.getByRole("button", { name: /queue prototype run/i }));

    expect(await screen.findByRole("heading", { name: "Queued run status" })).toBeInTheDocument();
    expect(screen.getByText("LWR-123")).toBeInTheDocument();
    expect(screen.getByText("FN-222")).toBeInTheDocument();
    const returnedArtifacts = screen.getByRole("list", { name: "Returned artifacts" });
    expect(within(returnedArtifacts).getByText("Claim map")).toBeInTheDocument();
    expect(within(returnedArtifacts).getByText("Opposing-counsel red-team report")).toBeInTheDocument();
  });

  it("shows a friendly error when the backend endpoint is not installed yet", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    mockStartCounterLawsuitPrototypeWorkflow.mockRejectedValue(
      new Error("API returned HTML instead of JSON for /api/legal-workflows/counter-lawsuit/runs. (404 Not Found)"),
    );

    render(<CounterLawsuitWorkflowView addToast={addToast} />);

    await user.type(screen.getByLabelText("Matter or workflow name"), "Acme matter");
    await user.click(screen.getByRole("button", { name: /queue prototype run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("workflow API is not installed yet");
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("server orchestration must be added"), "error");
  });
});
