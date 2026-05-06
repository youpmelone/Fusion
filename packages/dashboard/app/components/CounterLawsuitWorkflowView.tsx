import { FormEvent, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Scale } from "lucide-react";
import {
  startCounterLawsuitPrototypeWorkflow,
  type CounterLawsuitWorkflowArtifact,
  type CounterLawsuitWorkflowRunStatus,
  type StartCounterLawsuitPrototypeWorkflowInput,
  type StartCounterLawsuitPrototypeWorkflowResponse,
} from "../api";
import "./CounterLawsuitWorkflowView.css";

interface CounterLawsuitWorkflowViewProps {
  projectId?: string;
  addToast?: (message: string, type?: "success" | "error" | "info") => void;
}

const REQUESTED_ARTIFACTS = [
  { id: "research-memo", label: "Research memo" },
  { id: "evidence-ledger", label: "Evidence ledger" },
  { id: "claim-map", label: "Claim map" },
  { id: "draft-counter-lawsuit-complaint", label: "Draft counter-lawsuit complaint" },
  { id: "red-team-report", label: "Opposing-counsel red-team report" },
  { id: "lineage-scoring-log", label: "Lineage/scoring log" },
] as const;

const SAFEGUARDS: StartCounterLawsuitPrototypeWorkflowInput["safeguards"] = {
  citationSourceVerification: true,
  opposingCounselRedTeam: true,
  preserveLineage: true,
  humanVerificationRequired: true,
};

const SAFETY_BOUNDARIES = [
  {
    title: "Citation/source verification",
    description: "Every cited authority and source must be checked against source material before use.",
  },
  {
    title: "Opposing-counsel red team",
    description: "The prototype must challenge the theory from the other side before any human relies on it.",
  },
  {
    title: "Lineage preservation",
    description: "Artifacts must preserve source lineage so reviewers can trace every generated claim.",
  },
  {
    title: "Human verification required",
    description: "Generated materials are not legal advice and require qualified human verification before use.",
  },
] as const;

function getFriendlyErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unable to queue the prototype workflow. Please try again.";
  }

  const message = error.message;
  const lower = message.toLowerCase();
  if (lower.includes("html instead of json") || lower.includes("not found") || lower.includes("404")) {
    return "The counter-lawsuit workflow API is not installed yet. The UI contract is ready, but server orchestration must be added before runs can queue.";
  }

  return message || "Unable to queue the prototype workflow. Please try again.";
}

function statusDotClass(status: CounterLawsuitWorkflowRunStatus | CounterLawsuitWorkflowArtifact["status"]): string {
  if (status === "queued" || status === "starting" || status === "pending") return "status-dot status-dot--pending";
  if (status === "running" || status === "generating") return "status-dot status-dot--connecting";
  if (status === "completed" || status === "ready") return "status-dot status-dot--online";
  if (status === "failed") return "status-dot status-dot--error";
  return "status-dot";
}

export function CounterLawsuitWorkflowView({ projectId, addToast }: CounterLawsuitWorkflowViewProps) {
  const [matterName, setMatterName] = useState("");
  const [focus, setFocus] = useState("");
  const [vaultScope, setVaultScope] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [run, setRun] = useState<StartCounterLawsuitPrototypeWorkflowResponse | null>(null);

  const requestedArtifactIds = useMemo(() => REQUESTED_ARTIFACTS.map((artifact) => artifact.id), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedMatterName = matterName.trim();
    if (!trimmedMatterName) {
      setValidationError("Enter a matter or workflow name before launching the prototype.");
      setApiError(null);
      return;
    }

    setValidationError(null);
    setApiError(null);
    setSubmitting(true);

    const input: StartCounterLawsuitPrototypeWorkflowInput = {
      matterName: trimmedMatterName,
      focus: focus.trim() || undefined,
      vaultScope: vaultScope.trim() || undefined,
      requestedArtifacts: [...requestedArtifactIds],
      safeguards: SAFEGUARDS,
    };

    try {
      const response = await startCounterLawsuitPrototypeWorkflow(input, projectId);
      setRun(response);
      addToast?.("Counter-lawsuit prototype workflow queued", "success");
    } catch (error) {
      const friendlyMessage = getFriendlyErrorMessage(error);
      setApiError(friendlyMessage);
      addToast?.(friendlyMessage, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="counter-lawsuit-view" aria-labelledby="counter-lawsuit-title">
      <section className="counter-lawsuit-view__hero card">
        <div className="counter-lawsuit-view__hero-copy">
          <p className="counter-lawsuit-view__eyebrow">Prototype legal workflow</p>
          <h1 id="counter-lawsuit-title">Counter-lawsuit prototype</h1>
          <p className="counter-lawsuit-view__subtitle">
            Queue a guarded prototype run that prepares review-ready research scaffolding for a potential counter-lawsuit strategy.
          </p>
        </div>
        <div className="counter-lawsuit-view__hero-badge" aria-label="Human verification required">
          <Scale aria-hidden="true" />
          <span>Human review required</span>
        </div>
      </section>

      <section className="counter-lawsuit-view__notice card" aria-labelledby="counter-lawsuit-safety-copy">
        <AlertTriangle aria-hidden="true" />
        <div>
          <h2 id="counter-lawsuit-safety-copy">Prototype safety boundary</h2>
          <p>
            Generated materials are not legal advice. They are unverified drafts that require qualified human verification before filing, sending, or relying on them.
          </p>
        </div>
      </section>

      <div className="counter-lawsuit-view__layout">
        <section className="counter-lawsuit-view__panel card" aria-labelledby="counter-lawsuit-launch-title">
          <div className="counter-lawsuit-view__section-heading">
            <h2 id="counter-lawsuit-launch-title">Launch context</h2>
            <p>Keep the first run narrow. The backend orchestration is expected to use this client contract in follow-up work.</p>
          </div>

          <form className="counter-lawsuit-view__form" onSubmit={handleSubmit} noValidate>
            <div className="form-group counter-lawsuit-view__field">
              <label htmlFor="counter-lawsuit-matter">Matter or workflow name</label>
              <input
                id="counter-lawsuit-matter"
                className="input"
                value={matterName}
                onChange={(event) => setMatterName(event.target.value)}
                aria-invalid={Boolean(validationError)}
                aria-describedby={validationError ? "counter-lawsuit-validation" : undefined}
                placeholder="Acme response strategy"
              />
            </div>

            <div className="form-group counter-lawsuit-view__field">
              <label htmlFor="counter-lawsuit-focus">Optional focus</label>
              <textarea
                id="counter-lawsuit-focus"
                className="input counter-lawsuit-view__textarea"
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
                placeholder="Claims, timeline, jurisdiction, or opposing-party conduct to prioritize"
              />
            </div>

            <div className="form-group counter-lawsuit-view__field">
              <label htmlFor="counter-lawsuit-vault-scope">Optional vault scope</label>
              <input
                id="counter-lawsuit-vault-scope"
                className="input"
                value={vaultScope}
                onChange={(event) => setVaultScope(event.target.value)}
                placeholder="Vault folder, tag, or corpus boundary"
              />
            </div>

            {validationError && (
              <p id="counter-lawsuit-validation" className="form-error" role="alert">
                {validationError}
              </p>
            )}

            {apiError && (
              <p className="counter-lawsuit-view__api-error form-error" role="alert">
                {apiError}
              </p>
            )}

            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? <Loader2 className="counter-lawsuit-view__spinner" aria-hidden="true" /> : <FileText aria-hidden="true" />}
              {submitting ? "Queueing prototype…" : "Queue prototype run"}
            </button>
          </form>
        </section>

        <aside className="counter-lawsuit-view__panel card" aria-labelledby="counter-lawsuit-artifacts-title">
          <div className="counter-lawsuit-view__section-heading">
            <h2 id="counter-lawsuit-artifacts-title">Expected artifacts</h2>
            <p>These artifacts are requested by the UI and returned status-first by the workflow API.</p>
          </div>
          <ul className="counter-lawsuit-view__artifact-list">
            {REQUESTED_ARTIFACTS.map((artifact) => (
              <li key={artifact.id}>
                <CheckCircle2 aria-hidden="true" />
                <span>{artifact.label}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <section className="counter-lawsuit-view__panel card" aria-labelledby="counter-lawsuit-integrations-title">
        <div className="counter-lawsuit-view__section-heading">
          <h2 id="counter-lawsuit-integrations-title">Integration summary</h2>
          <p>
            The dashboard sends matter context, artifact requests, and fixed safeguards to the typed API contract. Court data, vault mining, legal skills, and agent orchestration are intentionally left to follow-up server work.
          </p>
        </div>
      </section>

      <section className="counter-lawsuit-view__safety-grid" aria-labelledby="counter-lawsuit-boundaries-title">
        <h2 id="counter-lawsuit-boundaries-title" className="counter-lawsuit-view__grid-title">Mandatory safety boundaries</h2>
        {SAFETY_BOUNDARIES.map((boundary) => (
          <article key={boundary.title} className="counter-lawsuit-view__safety-card card">
            <div className="counter-lawsuit-view__safety-title-row">
              <span className="status-dot status-dot--pending" aria-hidden="true" />
              <h3>{boundary.title}</h3>
            </div>
            <p>{boundary.description}</p>
          </article>
        ))}
      </section>

      {run && (
        <section className="counter-lawsuit-view__result card" aria-labelledby="counter-lawsuit-result-title">
          <div className="counter-lawsuit-view__section-heading">
            <h2 id="counter-lawsuit-result-title">Queued run status</h2>
            {run.message && <p>{run.message}</p>}
          </div>
          <dl className="counter-lawsuit-view__run-meta">
            <div>
              <dt>Run ID</dt>
              <dd>{run.runId}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd className="counter-lawsuit-view__status-value">
                <span className={statusDotClass(run.status)} aria-hidden="true" />
                {run.status}
              </dd>
            </div>
            {run.taskId && (
              <div>
                <dt>Task ID</dt>
                <dd>{run.taskId}</dd>
              </div>
            )}
          </dl>
          <ul className="counter-lawsuit-view__returned-artifacts" aria-label="Returned artifacts">
            {run.artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span className={statusDotClass(artifact.status)} aria-hidden="true" />
                <span>{artifact.label}</span>
                <span className="counter-lawsuit-view__artifact-status">{artifact.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
