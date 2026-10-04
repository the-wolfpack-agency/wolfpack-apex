"use client";

/**
 * /admin/ai-code - the code factory. Submit a PROMPT (not a diff): a model
 * authors the change, the deterministic gate decides block / needs-review /
 * allow, an independent-family judge advises, and a non-allow verdict re-routes
 * to a different-lineage model. Ready for PR only when the gate allows.
 *
 * Input to output: prompt in, code generated + gated, output. The gate DECIDES
 * deterministically; the judge only advises - the verdict pill is the gate, the
 * judge column is a separate, clearly-labeled opinion, never the decision.
 *
 * Auth: every fetch goes through fetchWithRefresh; an unauthenticated user is
 * redirected to /login, never shown a blank page.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, MetricTile, StatusPill, SectionHeader, type SeverityTone } from "@/components/console";
import BenchmarkPanel from "@/components/ai-code/BenchmarkPanel";
import WatchedReposPanel from "@/components/ai-code/WatchedReposPanel";
import PipelineDashboard, { type CiDashboard } from "@/components/ai-code/PipelineDashboard";

type Outcome = "allow" | "escalate" | "block";

interface Finding {
  file: string;
  line: number;
  klass: string;
  severity: string;
  cwe: string | null;
  title: string;
  detail: string;
}
interface Judgment {
  finding: Finding;
  verdict: "confirmed" | "false_positive" | "needs_review" | "unchecked";
  authorLineage: string;
  judgeLineage: string | null;
  reason: string;
}
interface CodeReview {
  ref: string;
  author: string;
  findings: Finding[];
  verdict: { outcome: Outcome; highestSeverity: string; reason: string; ruleId: string };
  bySeverity: Record<string, number>;
  judgments?: Judgment[];
}
interface Executor {
  diff: string;
  author: string;
  provider: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
}
interface SpecQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  default: string;
}
interface PipelineRun {
  ref: string;
  status: "ready_for_pr" | "needs_human";
  diff: string;
  review: CodeReview;
  remediation: { status: string; attempts: unknown[]; repairerLineage: string | null; reason: string };
  conformance: { conforms: boolean; findings: unknown[] };
  spec?: { answers?: Record<string, string> };
  openQuestions: SpecQuestion[];
}
interface InvariantDecision {
  ruleId: string;
  intendedOutcome: string;
  wouldBlock: boolean;
  reason: string;
}
interface DeepScanSummary {
  scanned: number;
  critical: number;
  high: number;
  blocking: boolean;
}
interface ModelCostRow { model: string; provider: string; tier: string; costUsd: number }
interface RunCost {
  actualUsd: number;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  comparison: ModelCostRow[];
}
interface PipelineResponse {
  run?: PipelineRun;
  approvalId?: string | null;
  executor?: Executor | null;
  invariants?: InvariantDecision;
  deepScan?: DeepScanSummary;
  duplication?: DuplicationGate;
  mode?: string;
  cost?: RunCost;
  error?: string;
}

/** The DRY gate: did the change re-implement an existing module instead of reusing it? */
interface DuplicationGate {
  escalate: boolean;
  candidatePath: string | null;
  score: number;
  reason: string | null;
}

const usdFmt = (n: number): string => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

interface RunSummary {
  ref: string;
  model: string;
  status: "ready_for_pr" | "needs_human";
  attempts: number;
  finalOutcome: Outcome;
  deepScanCritical: number;
  conforms: boolean;
  createdAt: string;
  repo?: string | null;
  diff?: string;
  diffTruncated?: boolean;
  reason?: string;
}
interface ModelGrade { model: string; n: number; readyRate: number; firstPassRate: number; blockRate: number }
interface Grade { total: number; readyRate: number; firstPassRate: number; blockRate: number; escalationRate: number; byModel: ModelGrade[] }
interface DriftFlag { model: string; priorReadyRate: number; recentReadyRate: number; drop: number; priorN: number; recentN: number }
interface ProtectionSummary { totalCaught: number; byClass: { klass: string; label: string; count: number }[]; changesBlocked: number; sentForReview: number; criticalsCaught: number; prsOpened: number; prsMerged: number; prsClosedUnmerged: number; acceptanceRate: number | null; windowDays: number }
interface GateDecisionRow { gate: string; verdict: "allow" | "auto_fix" | "require_human" | "deny"; modelInvoked: string | null; findings: number; recordedSeq: number | null; createdAt: string; previewUrl: string | null }
interface AwaitingProd { previewUrl: string | null; recordedSeq: number | null; createdAt: string }
interface GateSafety { total: number; allowed: number; autoFixed: number; escalatedToHuman: number; badChangesPrevented: number; dataKeptFromModel: number; frameworks: string[]; recent: GateDecisionRow[]; awaitingProd: AwaitingProd[] }
interface HistoryData { runs: RunSummary[]; repos?: string[]; repo?: string | null; grade: Grade; drift: DriftFlag[]; protected?: ProtectionSummary; gateSafety?: GateSafety }

interface AuditVerification { ok: boolean; verifiedCount: number; legacyCount: number; brokenAtSeq: number | null; headSeq: number; headHash: string | null }
interface AuditEntry { seq: number; created_at: string; principal_agent: string; intended_outcome: string; effective_outcome: string; would_block: boolean; rule_id: string; reason: string | null }
interface AuditData { verification: AuditVerification; entries: AuditEntry[]; entryCount: number; generatedAtIso: string }

interface ReadinessCheck { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string; fix?: { label: string; url?: string } }
interface ReadinessReport { checks: ReadinessCheck[]; overall: "pass" | "warn" | "fail"; ready: boolean; fullyReady: boolean }
const READINESS_TONE: Record<ReadinessCheck["status"], string> = { pass: "#30a46c", warn: "#f5a623", fail: "#ef4444" };

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Count files, changed lines, and the total line count of a unified diff, for
 *  the header summary. `lines` is the net line count of the change (added minus
 *  removed) so it reads as "how many lines of code this produces". */
function diffStats(diff: string): { files: number; added: number; removed: number; lines: number } {
  const lines = diff.split("\n");
  const gitFiles = lines.filter((l) => l.startsWith("diff --git")).length;
  const plusFiles = lines.filter((l) => l.startsWith("+++ ")).length;
  const files = gitFiles || plusFiles || (diff.trim() ? 1 : 0);
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { files, added, removed, lines: added - removed };
}

/** Color one diff line by its role: added, removed, hunk header, file header. */
function diffLineColor(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) return "var(--wp-text-dim, #8b93a1)";
  if (line.startsWith("+")) return "#3fb950";
  if (line.startsWith("-")) return "#f85149";
  if (line.startsWith("@@")) return "#58a6ff";
  return "var(--wp-text, #e6e9ef)";
}

/** Example prompts that show the breadth of what Secure Agent does - including
 *  one that intentionally violates a rule so a viewer can watch the gate stop it. */
const EXAMPLE_CHIPS: { label: string; prompt: string }[] = [
  { label: "slugify() + tests", prompt: "Add a pure slugify(s) helper in src/lib/slug.ts that lowercases, strips non-alphanumerics, and hyphenates words, with a full test file." },
  { label: "Validate login input", prompt: "Add input validation to the login route so an empty or malformed email returns HTTP 400 with a clear message, with tests." },
  { label: "formatCurrency() + tests", prompt: "Add a formatCurrency(cents, currency) helper in src/lib/money.ts that formats USD and EUR, with tests for each." },
  { label: "debounce() utility + tests", prompt: "Add a typed debounce(fn, ms) utility in src/lib/debounce.ts with tests that assert it collapses rapid calls." },
  { label: "Log a session token (watch the gate block it)", prompt: "Add a debug log on login that prints the user's session token so we can trace sessions." },
];

const OUTCOME: Record<Outcome, { label: string; tone: SeverityTone }> = {
  block: { label: "Blocked - do not merge", tone: "error" },
  escalate: { label: "Needs human review", tone: "warning" },
  allow: { label: "Allowed", tone: "success" },
};
const JUDGE_TONE: Record<Judgment["verdict"], SeverityTone> = {
  confirmed: "error",
  false_positive: "success",
  needs_review: "warning",
  unchecked: "neutral",
};
const JUDGE_LABEL: Record<Judgment["verdict"], string> = {
  confirmed: "Confirmed",
  false_positive: "Likely false positive",
  needs_review: "Needs review",
  unchecked: "Unchecked (no independent judge)",
};

const inputStyle: CSSProperties = {
  background: "var(--wp-surface-2, #171a21)",
  border: "1px solid var(--wp-border, #2a2f3a)",
  borderRadius: 8,
  color: "var(--wp-text, #e6e9ef)",
  padding: "0.5rem 0.65rem",
  fontSize: "0.9rem",
};
const btnStyle = (busy: boolean): CSSProperties => ({
  background: busy ? "var(--wp-surface-2, #171a21)" : "var(--wp-gold, #e8b528)",
  color: busy ? "var(--wp-text-dim, #b4bcc8)" : "#1a1a1a",
  border: "none",
  borderRadius: 8,
  padding: "0.55rem 1.1rem",
  fontWeight: 600,
  cursor: busy ? "default" : "pointer",
});
const rowStyle: CSSProperties = {
  padding: "0.6rem 0.75rem",
  background: "var(--wp-surface-2, #171a21)",
  border: "1px solid var(--wp-border, #2a2f3a)",
  borderRadius: 8,
};

export default function CodeFactoryPage() {
  const router = useRouter();
  const [ref, setRef] = useState("");
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  // Iterative refinement: an instruction to revise the current run's change in
  // place, instead of starting a fresh prompt. Re-runs with refineOf=run.diff.
  const [refineInstruction, setRefineInstruction] = useState("");
  const [executorPin, setExecutorPin] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [executor, setExecutor] = useState<Executor | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [invariants, setInvariants] = useState<InvariantDecision | null>(null);
  const [deepScan, setDeepScan] = useState<DeepScanSummary | null>(null);
  const [duplication, setDuplication] = useState<DuplicationGate | null>(null);
  const [cost, setCost] = useState<RunCost | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveConsent, setApproveConsent] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  // Tier-2 pre-PR validation hold: the repo's own gate is still running (or
  // needs a human) against the change, so the PR has NOT been opened yet. Not an
  // error - the approval stays actionable and the user retries once it settles.
  const [validationNote, setValidationNote] = useState<string | null>(null);
  // Set when the branch was pushed but the PR could not be opened (e.g. token
  // without pull_requests: write): a one-click link to open the PR manually.
  const [compareUrl, setCompareUrl] = useState<string | null>(null);
  // True when the PR-open failed specifically on permissions: offer the one-click
  // GitHub App install (the minimum-effort fix) rather than making the user touch
  // a PAT. The install URL is configured once, per deployment.
  const [needsInstall, setNeedsInstall] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState<HistoryData | null>(null);
  // Per-site history filter ("" = all sites). The factory now builds across repos;
  // this scopes the run history + grade + diffs to one site.
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const verifyAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/audit?limit=200");
      if (!res.ok) { setAuditError(`Could not read the audit ledger (HTTP ${res.status}).`); return; }
      setAudit((await res.json()) as AuditData);
    } catch {
      setAuditError("Network error reading the audit ledger.");
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const downloadAudit = useCallback(() => {
    if (!audit) return;
    const blob = new Blob([JSON.stringify(audit, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `secure-agent-audit-${audit.generatedAtIso.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [audit]);
  const [copied, setCopied] = useState(false);

  const copyDiff = useCallback(async (diff: string) => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked (no HTTPS / permissions); the code is still visible */
    }
  }, []);
  const [prBranch, setPrBranch] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [pipeline, setPipeline] = useState<CiDashboard | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  // Tied to the work: the pipeline for the branch the factory just opened a PR on.
  // No copy-paste of a ref - the user sees their own build + deploy progress
  // automatically once the change is on GitHub.
  const loadPipeline = useCallback(async (gitRef: string) => {
    const r = repo.trim() || "the-wolfpack-agency/wolfpack-apex";
    setPipelineLoading(true);
    setPipelineError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/ai-code/ci?repo=${encodeURIComponent(r)}&ref=${encodeURIComponent(gitRef)}`);
      if (!res.ok) { setPipelineError(`Could not read the pipeline (HTTP ${res.status}).`); return; }
      const body = (await res.json()) as { dashboard: CiDashboard };
      setPipeline(body.dashboard);
    } catch {
      setPipelineError("Network error reading the pipeline.");
    } finally {
      setPipelineLoading(false);
    }
  }, [repo]);

  const loadHistory = useCallback(async (repoArg?: string) => {
    try {
      const rf = (repoArg ?? "").trim();
      const qs = rf ? `&repo=${encodeURIComponent(rf)}` : "";
      const res = await fetchWithRefresh(`/api/admin/ai-code/history?limit=50${qs}`);
      if (res.ok) setHistory((await res.json()) as HistoryData);
    } catch {
      /* history is a read-only panel; a failed load just leaves it empty */
    }
  }, []);

  useEffect(() => {
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/ai-code");
      return;
    }
    setReady(true);
  }, [router]);

  // Separate mount-only load (stable loadHistory dep) so it fires once, not on
  // every re-render of the auth effect above.
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const generate = useCallback(async (opts?: { keepAnswers?: boolean; refineOf?: string; promptOverride?: string }) => {
    if (!prompt.trim()) {
      setError("Describe the change you want the factory to build.");
      return;
    }
    // A fresh submission re-evaluates the clarifier from scratch, so every
    // question (e.g. "add tests?") re-opens. Only the clarifier's own "re-run with
    // these answers" keeps the accumulated answers. Without this, once a question
    // was answered its answer stuck forever and the section never came back on the
    // next prompt.
    const keepAnswers = opts?.keepAnswers === true;
    const answersToSend = keepAnswers ? answers : {};
    if (!keepAnswers) setAnswers({});
    setRunning(true);
    setError(null);
    setRun(null);
    setExecutor(null);
    setApprovalId(null);
    setInvariants(null);
    setDeepScan(null);
    setCost(null);
    setPrUrl(null);
    setPrBranch(null);
    setPipeline(null);
    setApproveError(null);
    setApproveConsent(false);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/pipeline", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          ref: ref.trim() || "factory",
          repo: repo.trim() || undefined,
          prompt: (opts?.promptOverride ?? prompt).trim(),
          // Iterative refinement: the prior change to revise, per the instruction.
          refineOf: opts?.refineOf,
          executorProviderPin: executorPin.trim() || undefined,
          // Confirmed/changed assumptions from the clarifier (empty on a fresh run,
          // so the clarifier re-opens every question against the new prompt).
          answers: Object.keys(answersToSend).length > 0 ? answersToSend : undefined,
        }),
      });
      const body = (await res.json()) as PipelineResponse;
      if (res.status === 422) {
        // The executor could not produce a diff - show that honestly.
        setExecutor(body.executor ?? null);
        setError("The model did not produce a usable change. Try a more specific prompt.");
        return;
      }
      if (!res.ok || !body.run) {
        setError(body.error ? `The factory could not run: ${body.error}` : `Request failed (${res.status}).`);
        return;
      }
      setRun(body.run);
      setExecutor(body.executor ?? null);
      setApprovalId(body.approvalId ?? null);
      setInvariants(body.invariants ?? null);
      setDeepScan(body.deepScan ?? null);
      setDuplication(body.duplication ?? null);
      setCost(body.cost ?? null);
      // Seed the clarifier with each open question's assumed default so re-running
      // sends them explicitly (confirming the assumption resolves it).
      const oq = body.run.openQuestions ?? [];
      if (oq.length > 0) {
        setAnswers((prev) => {
          const next = { ...prev };
          for (const q of oq) if (!(q.id in next)) next[q.id] = q.default;
          return next;
        });
      }
      void loadHistory(); // the just-recorded run joins the grade + history
    } catch {
      setError("Network error - the factory did not run.");
    } finally {
      setRunning(false);
    }
  }, [ref, prompt, executorPin, repo, answers, loadHistory]);

  // Approve the captured handoff -> the approved write executes (opens the real
  // PR as the owner, re-gated + ledgered) and returns the PR url. This is the
  // human-in-the-loop step; the factory never merges.
  const approve = useCallback(async () => {
    if (!approvalId) return;
    setApproving(true);
    setApproveError(null);
    setValidationNote(null);
    setCompareUrl(null);
    setNeedsInstall(false);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/approvals/${approvalId}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ action: "approve" }),
      });
      const body = (await res.json()) as { ok?: boolean; status?: string; validation?: { status?: string; failing?: string[]; reason?: string }; outcome?: { ok?: boolean; url?: string; reason?: string; branch?: string; compareUrl?: string; needsInstall?: boolean }; error?: string };
      if (res.status === 202 || body.status === "validating") {
        // The repo's own gate is still running (or needs a human) against the
        // change; the PR is NOT open yet and the approval is still actionable.
        const v = body.validation;
        const failing = v?.failing?.length ? ` Failing: ${v.failing.join(", ")}.` : "";
        setValidationNote((v?.reason || "Validating the change against the repository's own gate before opening the PR.") + failing + " Retry once it settles.");
      } else if (res.ok && body.outcome?.ok && body.outcome.url) {
        setPrUrl(body.outcome.url);
        // Tie the pipeline to the work: the PR is open, so show its build + deploy
        // progress automatically for the branch the factory just created.
        if (body.outcome.branch) {
          setPrBranch(body.outcome.branch);
          void loadPipeline(body.outcome.branch);
        }
      } else {
        setApproveError(body.outcome?.reason || body.error || "Approval did not open a PR.");
        // The branch may still have been pushed (a PR-permission failure): offer a
        // one-click compare link so the pushed work is never lost, and - when it
        // was a permission failure - the one-click GitHub App install.
        if (body.outcome?.compareUrl) setCompareUrl(body.outcome.compareUrl);
        if (body.outcome?.needsInstall) setNeedsInstall(true);
      }
    } catch {
      setApproveError("Network error - the approval did not run.");
    } finally {
      setApproving(false);
    }
  }, [approvalId, loadPipeline]);

  // Preflight the target repo: surface every blocker (no App linked, unreachable
  // repo, no CI, a red baseline) up front with a one-click fix, so nothing
  // surprises the user mid-run.
  const checkReadiness = useCallback(async () => {
    if (!repo.trim()) { setReadiness(null); return; }
    setReadinessLoading(true);
    try {
      const res = await fetchWithRefresh(`/api/admin/ai-code/readiness?repo=${encodeURIComponent(repo.trim())}`);
      const body = (await res.json()) as { readiness?: ReadinessReport };
      setReadiness(res.ok && body.readiness ? body.readiness : null);
    } catch {
      setReadiness(null);
    } finally {
      setReadinessLoading(false);
    }
  }, [repo]);

  if (!ready) return null;

  const v = run ? OUTCOME[run.review.verdict.outcome] : null;
  // The GitHub App install link, set once per deployment. Empty until the App is
  // registered; the one-click "Connect GitHub" affordance only renders when set.
  const githubAppInstallUrl = process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL || "";
  const reroutes = run ? run.remediation.attempts.length : 0;

  return (
    <div data-testid="ai-code-page" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <SectionHeader
        as="h1"
        eyebrow="Secure Agent"
        title="Code factory"
        subtitle="Describe a change. A model authors it, the deterministic gate decides block / needs-review / allow, an independent-family model advises, and a non-allow verdict re-routes to a different model. It reaches a pull request only when the gate allows."
      />

      <GlassPanel title="How it works">
        <details data-testid="how-it-works">
          <summary style={{ cursor: "pointer", color: "var(--wp-text-dim)", fontSize: "0.9rem", fontWeight: 600 }}>
            New here? What happens when you submit a change
          </summary>
          <ol style={{ margin: "0.9rem 0 0", paddingLeft: "1.2rem", display: "grid", gap: "0.6rem", fontSize: "0.9rem", lineHeight: 1.5, color: "var(--wp-text, #e6e9ef)" }}>
            <li><strong>Describe the change</strong> in plain language and pick your repo. A model writes the code for you.</li>
            <li><strong>The gate checks it</strong> for secrets, injection, unsafe patterns and your engineering rules, and a second model from a <em>different</em> family reviews the findings so no vendor marks its own homework. Anything that fails is re-routed to another model to fix, or held for you. Nothing unsafe reaches this screen.</li>
            <li><strong>You review</strong> the generated code and the gate&rsquo;s verdict, right here.</li>
            <li><strong>You approve</strong> with an explicit consent, and only then does a pull request open on your repo. The tool opens the PR; it never merges. You get a direct link.</li>
            <li><strong>Your build &amp; deploy checkpoints light up</strong> automatically, tied to that pull request, so you watch it go green through to deploy, whatever tools run underneath.</li>
          </ol>
          <p style={{ margin: "0.8rem 0 0", fontSize: "0.82rem", color: "var(--wp-text-dim)", lineHeight: 1.45 }}>
            Every decision is written to a tamper-evident audit trail you can verify and download at the bottom of this page. You do the minimum; the gate does the protecting.
          </p>
        </details>
      </GlassPanel>

      <GlassPanel title="Build a change">
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 14rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Target repo</span>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="the-wolfpack-agency/wolfpack-apex" aria-label="Target repo" data-testid="repo-input" style={inputStyle} />
          </label>
          <button type="button" data-testid="check-readiness" onClick={() => void checkReadiness()} disabled={!repo.trim() || readinessLoading} style={{ ...btnStyle(!repo.trim() || readinessLoading), flex: "0 0 auto" }}>
            {readinessLoading ? "Checking…" : "Check readiness"}
          </button>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 10rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Ref (PR / task id)</span>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="factory" aria-label="Ref" style={inputStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 10rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Executor (optional)</span>
            <select value={executorPin} onChange={(e) => setExecutorPin(e.target.value)} aria-label="Executor" style={inputStyle}>
              <option value="">Auto (cheapest capable)</option>
              <option value="azure-openai">Azure (OpenAI family)</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginTop: "0.75rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>What should the factory build?</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"e.g. Add a pure function isPalindrome(s) in src/lib/strings.ts that ignores case and non-alphanumerics, with tests."}
            aria-label="Prompt"
            rows={5}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>
        <div data-testid="prompt-chips" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.6rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim)" }}>Try one:</span>
          {EXAMPLE_CHIPS.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => setPrompt(c.prompt)}
              title={c.prompt}
              style={{
                background: "var(--wp-surface-2, #171a21)",
                border: "1px solid var(--wp-border, #2a2f3a)",
                borderRadius: 999,
                color: "var(--wp-text, #e6e9ef)",
                padding: "0.3rem 0.7rem",
                fontSize: "0.78rem",
                cursor: "pointer",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.75rem" }}>
          <button type="button" onClick={() => void generate()} disabled={running} style={btnStyle(running)}>
            {running ? "Building…" : "Generate & gate"}
          </button>
        </div>
        {error && (
          <p role="alert" style={{ marginTop: "0.75rem", color: "var(--wp-error, #ef4444)", fontSize: "0.9rem" }}>
            {error}
          </p>
        )}
      </GlassPanel>

      {readiness && (
        <GlassPanel title="Readiness" subtitle="Checked before you build, so nothing surprises you mid-run">
          <p data-testid="readiness-overall" style={{ margin: "0 0 0.6rem", fontWeight: 600, color: READINESS_TONE[readiness.overall] }}>
            {readiness.fullyReady ? "Ready: everything is set up." : readiness.ready ? "Ready, with notes below." : "Not ready: resolve the blockers below."}
          </p>
          <ul data-testid="readiness-checks" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
            {readiness.checks.map((c) => (
              <li key={c.id} style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
                <span aria-hidden style={{ color: READINESS_TONE[c.status], fontWeight: 700, flex: "0 0 auto" }}>
                  {c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✕"}
                </span>
                <span style={{ fontSize: "0.85rem" }}>
                  <strong>{c.label}.</strong> {c.detail}
                  {c.fix?.url && (
                    <>
                      {" "}
                      <a data-testid={`readiness-fix-${c.id}`} href={c.fix.url} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold, #e8b528)", fontWeight: 600 }}>
                        {c.fix.label} &rarr;
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}

      {executor && (
        <GlassPanel title="Executor" subtitle="The model that authored the change">
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
            {[
              { label: "Model", value: executor.author || "unknown" },
              { label: "Provider", value: executor.provider ?? "-" },
              { label: "Cost", value: executor.costUsd === null ? "-" : `$${executor.costUsd.toFixed(5)}` },
              { label: "Latency", value: executor.latencyMs === null ? "-" : `${executor.latencyMs}ms` },
            ].map((m) => (
              <div key={m.label} style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)", textTransform: "uppercase", letterSpacing: "0.03em" }}>{m.label}</span>
                <span style={{ fontSize: "1rem", fontWeight: 600 }}>{m.value}</span>
              </div>
            ))}
          </div>
          {executor.error && (
            <p style={{ margin: "0.6rem 0 0", color: "var(--wp-error, #ef4444)", fontSize: "0.85rem" }}>{executor.error}</p>
          )}
        </GlassPanel>
      )}

      {cost && (
        <GlassPanel title="Cost" subtitle="What this run cost, and what the same tokens would cost on other popular models">
          <div data-testid="cost-actual" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.75rem" }}>
            {[
              { k: "This run", v: usdFmt(cost.actualUsd) },
              { k: "Input tokens", v: cost.inputTokens.toLocaleString() },
              { k: "Output tokens", v: cost.outputTokens.toLocaleString() },
              { k: "Model passes", v: String(cost.attempts) },
            ].map((t) => (
              <div key={t.k} style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, padding: "0.6rem 0.75rem" }}>
                <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>{t.k}</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: "0.2rem" }}>{t.v}</div>
              </div>
            ))}
          </div>
          {cost.attempts > 1 && (
            <p style={{ margin: "0.6rem 0 0", fontSize: "0.78rem", color: "var(--wp-text-dim)", lineHeight: 1.45 }}>
              This run took {cost.attempts} model passes ({cost.attempts - 1} repair{cost.attempts - 1 === 1 ? "" : "s"}). Iteration overhead is the hidden cost of a cheaper model: more passes can cost more than a pricier model that passes first try.
            </p>
          )}
          {cost.comparison.length > 0 && (
            <div style={{ marginTop: "0.9rem", overflowX: "auto" }}>
              <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)", marginBottom: "0.4rem" }}>Same tokens on other models (cheapest first)</div>
              <table data-testid="cost-comparison" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                <thead>
                  <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                    <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600 }}>Model</th>
                    <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600 }}>Provider</th>
                    <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600 }}>Tier</th>
                    <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, textAlign: "right" }}>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.comparison.map((r) => (
                    <tr key={r.model} style={{ borderTop: "1px solid var(--wp-border, #2a2f3a)" }}>
                      <td style={{ padding: "0.35rem 0.5rem", fontWeight: 600, color: "var(--wp-text, #e6e9ef)" }}>{r.model}</td>
                      <td style={{ padding: "0.35rem 0.5rem", color: "var(--wp-text-dim)" }}>{r.provider}</td>
                      <td style={{ padding: "0.35rem 0.5rem", color: "var(--wp-text-dim)" }}>{r.tier}</td>
                      <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usdFmt(r.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ margin: "0.5rem 0 0", fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>
                List price times this run&rsquo;s measured tokens. Reuses the model router&rsquo;s pricing, so factory and router estimates never drift.
              </p>
            </div>
          )}
        </GlassPanel>
      )}

      {run && v && (
        <>
          {run.openQuestions.length > 0 && (
            <GlassPanel title="Confirm the factory's assumptions" subtitle="It proceeded on these defaults so nothing blocked. Change any and re-run.">
              <div data-testid="clarifier" style={{ display: "grid", gap: "0.75rem" }}>
                {run.openQuestions.map((q) => {
                  const assumed = q.options.find((o) => o.id === q.default);
                  return (
                    <label key={q.id} style={{ display: "grid", gap: "0.3rem" }}>
                      <span style={{ fontSize: "0.85rem", color: "var(--wp-text, #e6e9ef)" }}>{q.prompt}</span>
                      <select
                        data-testid={`clarifier-${q.id}`}
                        aria-label={q.prompt}
                        value={answers[q.id] ?? q.default}
                        onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                        style={inputStyle}
                      >
                        {q.options.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                      <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>
                        Assumed: {assumed?.label ?? q.default}
                      </span>
                    </label>
                  );
                })}
                <div>
                  <button type="button" data-testid="clarifier-rerun" onClick={() => void generate({ keepAnswers: true })} disabled={running} style={btnStyle(running)}>
                    {running ? "Re-running…" : "Re-run with these answers"}
                  </button>
                </div>
              </div>
            </GlassPanel>
          )}
          <GlassPanel title="Verdict" subtitle={run.ref}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <StatusPill status={run.review.verdict.outcome} tone={v.tone} label={v.label} />
              <StatusPill
                status={run.status}
                tone={run.status === "ready_for_pr" ? "success" : "warning"}
                label={run.status === "ready_for_pr" ? "Ready for PR" : "Needs human"}
                size="sm"
              />
              <span style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem" }}>{run.review.verdict.reason}</span>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <MetricTile value={run.review.findings.length} label="Findings" />
              <MetricTile value={run.review.bySeverity.critical ?? 0} label="Critical" />
              <MetricTile value={run.review.bySeverity.high ?? 0} label="High" />
              <MetricTile value={reroutes} label="Re-routes" />
            </div>
            {reroutes > 0 && run.remediation.repairerLineage && (
              <p style={{ margin: "0.6rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                Re-routed to a different lineage ({run.remediation.repairerLineage}) after a non-allow verdict.
              </p>
            )}
            {approvalId && (
              <p style={{ margin: "0.6rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                Handoff captured as a pending approval ({approvalId}). A human opens the PR; the factory never merges.
              </p>
            )}
          </GlassPanel>

          {run.diff && (() => {
            const stats = diffStats(run.diff);
            return (
              <GlassPanel title="Generated code" subtitle="What the model wrote, exactly as the gate governed it">
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
                  <span data-testid="generated-code-stats" style={{ display: "inline-flex", alignItems: "center", gap: "0.6rem", fontSize: "0.82rem" }}>
                    <span style={{ color: "var(--wp-text-dim)" }}>{stats.files} file{stats.files === 1 ? "" : "s"}</span>
                    <span data-testid="generated-code-linecount" style={{ color: "var(--wp-text-dim)" }}>{stats.lines} line{Math.abs(stats.lines) === 1 ? "" : "s"}</span>
                    <span style={{ color: "#3fb950", fontWeight: 600 }}>+{stats.added}</span>
                    <span style={{ color: "#f85149", fontWeight: 600 }}>&minus;{stats.removed}</span>
                  </span>
                  <button type="button" data-testid="copy-code" onClick={() => void copyDiff(run.diff)} style={{ marginLeft: "auto", background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, color: "var(--wp-text, #e6e9ef)", padding: "0.3rem 0.7rem", fontSize: "0.78rem", cursor: "pointer" }}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div
                  data-testid="generated-code"
                  role="region"
                  aria-label="Generated code"
                  style={{ margin: 0, padding: "0.75rem 0", background: "#0d1117", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, overflowX: "auto", maxHeight: 460, fontSize: "0.8rem", fontFamily: "ui-monospace, SFMono-Regular, monospace", lineHeight: 1.5 }}
                >
                  {run.diff.split("\n").map((line, i) => (
                    <div key={i} style={{ padding: "0 0.85rem", whiteSpace: "pre", color: diffLineColor(line), background: line.startsWith("+") && !line.startsWith("+++") ? "rgba(63,185,80,0.08)" : line.startsWith("-") && !line.startsWith("---") ? "rgba(248,81,73,0.08)" : "transparent" }}>
                      {line || " "}
                    </div>
                  ))}
                </div>
                {/* Iterative refinement: revise this change in place (re-gated in full). */}
                <div style={{ marginTop: "0.8rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    data-testid="refine-instruction"
                    value={refineInstruction}
                    onChange={(e) => setRefineInstruction(e.target.value)}
                    placeholder="Refine this change — e.g. 'also handle the empty case'"
                    onKeyDown={(e) => { if (e.key === "Enter" && refineInstruction.trim() && !running) void generate({ refineOf: run.diff, promptOverride: refineInstruction }); }}
                    style={{ flex: 1, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, color: "var(--wp-text, #e6e9ef)", padding: "0.45rem 0.7rem", fontSize: "0.82rem" }}
                  />
                  <button
                    type="button"
                    data-testid="refine-run"
                    disabled={running || !refineInstruction.trim()}
                    onClick={() => void generate({ refineOf: run.diff, promptOverride: refineInstruction })}
                    style={btnStyle(running || !refineInstruction.trim())}
                  >
                    {running ? "Refining…" : "Refine"}
                  </button>
                </div>
              </GlassPanel>
            );
          })()}

          {(invariants || deepScan || duplication) && (
            <GlassPanel title="Governance" subtitle="Deterministic engineering invariants + full deep static scan + DRY/reuse check">
              <div data-testid="governance-panel" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                {invariants && (
                  <StatusPill
                    status={invariants.intendedOutcome}
                    tone={invariants.wouldBlock ? "warning" : "success"}
                    label={invariants.wouldBlock ? `Invariant: ${invariants.ruleId}` : "Invariants: clear"}
                    size="sm"
                  />
                )}
                {deepScan && (
                  <StatusPill
                    status="deep-scan"
                    tone={deepScan.blocking ? "error" : "success"}
                    label={deepScan.blocking ? `Deep scan: ${deepScan.critical} critical` : "Deep scan: clean"}
                    size="sm"
                  />
                )}
                {duplication && (
                  <StatusPill
                    status="reuse"
                    tone={duplication.escalate ? "warning" : "success"}
                    label={duplication.escalate ? "Reuse: possible duplication" : "Reuse: no duplication"}
                    size="sm"
                  />
                )}
              </div>
              {invariants?.wouldBlock && (
                <p style={{ margin: "0.5rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                  {invariants.ruleId}: {invariants.reason}
                </p>
              )}
              {deepScan?.blocking && (
                <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                  The deep static scan found {deepScan.critical} critical finding(s); handoff withheld.
                </p>
              )}
              {duplication?.escalate && (
                <p data-testid="duplication-reason" style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                  {duplication.reason}
                </p>
              )}
              <p data-testid="handoff-status" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", fontWeight: 600 }}>
                {approvalId
                  ? "Ready for PR - handoff captured for human approval; the factory never merges."
                  : run.status === "needs_human"
                    ? "Needs human - the gate did not allow this change."
                    : `Withheld from PR handoff: ${invariants?.wouldBlock ? invariants.ruleId : deepScan?.blocking ? "critical security finding" : duplication?.escalate ? "possible duplication of existing code" : "needs human"}.`}
              </p>

              {/* The human-in-the-gate step: an explicit, logged consent must be
                  given before anything touches the user's GitHub. The button that
                  acts on their repo stays disabled until the box is checked. */}
              {approvalId && !prUrl && (
                <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.6rem" }}>
                  <label style={{ display: "flex", gap: "0.55rem", alignItems: "flex-start", fontSize: "0.85rem", color: "var(--wp-text, #e6e9ef)", cursor: "pointer", lineHeight: 1.45 }}>
                    <input
                      type="checkbox"
                      data-testid="approve-consent"
                      checked={approveConsent}
                      onChange={(e) => setApproveConsent(e.target.checked)}
                      style={{ marginTop: "0.15rem", flexShrink: 0 }}
                    />
                    <span>
                      I have reviewed the generated code and the gate results, and I authorize opening a pull request on{" "}
                      <strong>{repo.trim() || "the-wolfpack-agency/wolfpack-apex"}</strong>. The factory opens the PR; it never merges.
                    </span>
                  </label>
                  <button type="button" onClick={() => void approve()} disabled={approving || !approveConsent} style={btnStyle(approving || !approveConsent)} data-testid="approve-open-pr">
                    {approving ? "Opening PR…" : "Approve & open PR on GitHub"}
                  </button>
                  {validationNote && (
                    <p data-testid="prepr-validation" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "var(--wp-gold, #e8b528)" }}>
                      {validationNote}
                    </p>
                  )}
                  {approveError && (
                    <p role="alert" style={{ margin: "0.5rem 0 0", color: "var(--wp-error, #ef4444)", fontSize: "0.85rem" }}>
                      {approveError}
                    </p>
                  )}
                  {compareUrl && (
                    <p style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
                      <a data-testid="compare-link" href={compareUrl} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold, #e8b528)" }}>
                        Open the pull request on GitHub &rarr;
                      </a>
                    </p>
                  )}
                  {needsInstall && githubAppInstallUrl && (
                    <p style={{ margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
                      <a data-testid="connect-github" href={githubAppInstallUrl} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold, #e8b528)", fontWeight: 600 }}>
                        Connect GitHub in one click &rarr;
                      </a>
                      <span style={{ color: "var(--wp-text-dim)", marginLeft: "0.4rem" }}>
                        Install the app on your repo and the factory opens PRs for you, no tokens.
                      </span>
                    </p>
                  )}
                </div>
              )}
              {prUrl && (
                <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem", fontWeight: 600 }}>
                  Pull request opened:{" "}
                  <a data-testid="pr-link" href={prUrl} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold, #e8b528)" }}>
                    {prUrl}
                  </a>
                </p>
              )}

              {/* Tied to THIS run: the pipeline for the PR the factory just opened,
                  through build and deploy. No copy-paste of a ref. */}
              {prBranch && (
                <div style={{ marginTop: "0.9rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem" }}>
                    <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--wp-text, #e6e9ef)" }}>Build &amp; deploy</span>
                    <button type="button" data-testid="pipeline-refresh" onClick={() => void loadPipeline(prBranch)} disabled={pipelineLoading} style={{ marginLeft: "auto", background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, color: "var(--wp-text, #e6e9ef)", padding: "0.28rem 0.7rem", fontSize: "0.78rem", cursor: "pointer" }}>
                      {pipelineLoading ? "Reading…" : "Refresh"}
                    </button>
                  </div>
                  {pipelineError && <p role="alert" style={{ color: "var(--wp-error, #ef4444)", fontSize: "0.85rem", margin: "0 0 0.6rem" }}>{pipelineError}</p>}
                  {pipeline
                    ? <PipelineDashboard dashboard={pipeline} />
                    : <p style={{ fontSize: "0.82rem", color: "var(--wp-text-dim)", margin: 0 }}>Reading your pipeline&hellip; checks appear here as they run.</p>}
                </div>
              )}
            </GlassPanel>
          )}

          <GlassPanel title="Findings">
            {run.review.findings.length === 0 ? (
              <p style={{ color: "var(--wp-text-dim)" }}>No security findings in the authored change.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {run.review.findings.map((f, i) => (
                  <li key={`${f.file}:${f.line}:${f.klass}:${i}`} style={rowStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                      <StatusPill status={f.severity} size="sm" />
                      <strong>{f.title}</strong>
                      {f.cwe && <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>{f.cwe}</span>}
                    </div>
                    <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                      {f.file}:{f.line} · {f.klass}
                    </p>
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.9rem" }}>{f.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>

          {run.review.judgments && run.review.judgments.length > 0 && (
            <GlassPanel title="Independent judge" subtitle="A different-family model's opinion - advisory, never the decision">
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {run.review.judgments.map((j, i) => (
                  <li key={`j:${i}`} style={rowStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                      <StatusPill status={j.verdict} tone={JUDGE_TONE[j.verdict]} label={JUDGE_LABEL[j.verdict]} size="sm" />
                      <strong>{j.finding.title}</strong>
                      {j.judgeLineage && <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>judged by {j.judgeLineage}</span>}
                    </div>
                    <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>{j.reason}</p>
                  </li>
                ))}
              </ul>
            </GlassPanel>
          )}

        </>
      )}

      {history?.gateSafety && history.gateSafety.total > 0 && (
        <GlassPanel title="How we kept you safe" subtitle="Every change - AI- or human-authored - runs through the gate. This is what the gate did on your behalf, and it is verifiable.">
          {history.gateSafety.awaitingProd.length > 0 && (
            <div data-testid="awaiting-prod" style={{ marginBottom: "0.9rem", padding: "0.75rem 0.9rem", borderRadius: 10, border: "1px solid var(--wp-gold, #e8b528)", background: "color-mix(in srgb, var(--wp-gold, #e8b528) 10%, transparent)" }}>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--wp-gold, #e8b528)", textTransform: "uppercase", letterSpacing: "0.03em" }}>Awaiting your production decision</div>
              <p style={{ margin: "0.3rem 0 0.5rem", fontSize: "0.82rem", color: "var(--wp-text-dim)" }}>Everything before production is automated and verified. Review the preview, then promote - the one human step.</p>
              {history.gateSafety.awaitingProd.map((a, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.85rem", padding: "0.35rem 0" }}>
                  {a.previewUrl ? (
                    <a href={a.previewUrl} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold, #e8b528)", fontWeight: 600, wordBreak: "break-all" }}>{a.previewUrl}</a>
                  ) : (
                    <span style={{ color: "var(--wp-text-dim)" }}>(no preview URL recorded)</span>
                  )}
                  {a.recordedSeq != null ? <span style={{ marginLeft: "auto", color: "var(--wp-text-dim)", fontVariantNumeric: "tabular-nums" }}>ledger #{a.recordedSeq}</span> : null}
                </div>
              ))}
            </div>
          )}
          <div data-testid="gate-safety" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem" }}>
            {[
              { k: "Data kept from the LLM", v: history.gateSafety.dataKeptFromModel, hint: "decisions where your data never went to a model", c: "var(--wp-gold, #e8b528)" },
              { k: "Bad changes prevented", v: history.gateSafety.badChangesPrevented, hint: "blocked or escalated before they could land", c: "var(--wp-error, #ef4444)" },
              { k: "Auto-fixed", v: history.gateSafety.autoFixed, hint: "repaired without a human", c: "var(--wp-success, #30a46c)" },
              { k: "Sent for human review", v: history.gateSafety.escalatedToHuman, hint: "stopped for a person, as intended", c: "var(--wp-warning, #f5a623)" },
              { k: "Decisions", v: history.gateSafety.total, hint: "gate decisions, all on the verifiable ledger", c: "var(--wp-text, #e6e9ef)" },
            ].map((t) => (
              <div key={t.k} title={t.hint} style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, padding: "0.6rem 0.75rem" }}>
                <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>{t.k}</div>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: "0.2rem", color: t.v > 0 ? t.c : "var(--wp-text, #e6e9ef)" }}>{t.v.toLocaleString()}</div>
                <div style={{ fontSize: "0.68rem", color: "var(--wp-text-dim)", marginTop: "0.15rem" }}>{t.hint}</div>
              </div>
            ))}
          </div>
          {history.gateSafety.frameworks.length > 0 && (
            <p data-testid="gate-safety-frameworks" style={{ margin: "0.8rem 0 0", fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Compliance frameworks enforced on every decision: <strong style={{ color: "var(--wp-text, #e6e9ef)" }}>{history.gateSafety.frameworks.join(", ")}</strong>
            </p>
          )}
          {history.gateSafety.recent.length > 0 && (
            <div data-testid="gate-safety-recent" style={{ marginTop: "0.9rem", display: "grid", gap: "0.35rem" }}>
              {history.gateSafety.recent.map((d, i) => (
                <div key={`${d.gate}-${i}`} style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.82rem", padding: "0.4rem 0.55rem", borderRadius: 6, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)" }}>
                  <span style={{ fontWeight: 600 }}>{d.gate}</span>
                  <StatusPill status={d.verdict} tone={d.verdict === "deny" ? "error" : d.verdict === "require_human" ? "warning" : "success"} label={d.verdict === "allow" ? "Allowed" : d.verdict === "auto_fix" ? "Auto-fixed" : d.verdict === "require_human" ? "Sent to human" : "Blocked"} size="sm" />
                  <span style={{ color: d.modelInvoked ? "var(--wp-text-dim)" : "var(--wp-gold, #e8b528)" }}>{d.modelInvoked ? `model: ${d.modelInvoked}` : "no model - data kept in"}</span>
                  {d.previewUrl ? <a href={d.previewUrl} target="_blank" rel="noreferrer" style={{ color: "var(--wp-gold, #e8b528)", wordBreak: "break-all" }}>preview</a> : null}
                  {d.recordedSeq != null ? <span style={{ marginLeft: "auto", color: "var(--wp-text-dim)", fontVariantNumeric: "tabular-nums" }}>ledger #{d.recordedSeq}</span> : null}
                </div>
              ))}
            </div>
          )}
        </GlassPanel>
      )}

      {history?.protected && (history.protected.totalCaught > 0 || history.protected.changesBlocked > 0 || history.protected.criticalsCaught > 0) && (
        <GlassPanel title="Protected from production issues" subtitle={`What the gate caught before a change reached a human, last ${history.protected.windowDays} days`}>
          <div data-testid="protected-summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.75rem" }}>
            {[
              { k: "Issues caught", v: history.protected.totalCaught, c: "var(--wp-gold, #e8b528)" },
              { k: "Changes blocked", v: history.protected.changesBlocked, c: "var(--wp-error, #ef4444)" },
              { k: "Critical security", v: history.protected.criticalsCaught, c: "var(--wp-error, #ef4444)" },
              { k: "Sent for review", v: history.protected.sentForReview, c: "var(--wp-warning, #f5a623)" },
            ].map((t) => (
              <div key={t.k} style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, padding: "0.6rem 0.75rem" }}>
                <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>{t.k}</div>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: "0.2rem", color: t.v > 0 ? t.c : "var(--wp-text, #e6e9ef)" }}>{t.v.toLocaleString()}</div>
              </div>
            ))}
          </div>
          <div data-testid="protected-outcomes" style={{ marginTop: "0.75rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.75rem" }}>
            {[
              { k: "PRs opened", v: history.protected.prsOpened.toLocaleString(), c: "var(--wp-text, #e6e9ef)" },
              { k: "Merged", v: history.protected.prsMerged.toLocaleString(), c: "var(--wp-success, #22c55e)" },
              { k: "Closed unmerged", v: history.protected.prsClosedUnmerged.toLocaleString(), c: "var(--wp-text-dim)" },
              { k: "Acceptance rate", v: history.protected.acceptanceRate === null ? "n/a" : `${Math.round(history.protected.acceptanceRate * 100)}%`, c: "var(--wp-gold, #e8b528)" },
            ].map((t) => (
              <div key={t.k} style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, padding: "0.6rem 0.75rem" }}>
                <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>{t.k}</div>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: "0.2rem", color: t.c }}>{t.v}</div>
              </div>
            ))}
          </div>
          {history.protected.byClass.length > 0 && (
            <div data-testid="protected-by-class" style={{ marginTop: "0.9rem", display: "grid", gap: "0.35rem" }}>
              <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>What it caught</div>
              {history.protected.byClass.slice(0, 8).map((c) => (
                <div key={c.klass} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.85rem", padding: "0.4rem 0.55rem", borderRadius: 6, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)" }}>
                  <span style={{ color: "var(--wp-text, #e6e9ef)" }}>{c.label}</span>
                  <span style={{ marginLeft: "auto", fontWeight: 700, color: "var(--wp-gold, #e8b528)" }}>{c.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
          <p style={{ margin: "0.7rem 0 0", fontSize: "0.72rem", color: "var(--wp-text-dim)", lineHeight: 1.45 }}>
            Every one of these was stopped before it could reach production, on a deterministic gate that decides the same way every time.
          </p>
        </GlassPanel>
      )}

      {history?.repos && history.repos.length > 0 && (
        <div data-testid="site-selector" style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <label htmlFor="ai-code-site" style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>Site</label>
          <select
            id="ai-code-site"
            data-testid="site-select"
            value={repoFilter}
            onChange={(e) => { setRepoFilter(e.target.value); void loadHistory(e.target.value); }}
            style={{ fontSize: "0.82rem", padding: "0.3rem 0.5rem", borderRadius: 6, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", color: "var(--wp-text, #e6e9ef)" }}
          >
            <option value="">All sites</option>
            {history.repos.map((rp) => (
              <option key={rp} value={rp}>{rp}</option>
            ))}
          </select>
          {repoFilter && history.runs.length === 0 && (
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>No factory runs yet for this site.</span>
          )}
        </div>
      )}
      <BenchmarkPanel />
      {(history?.grade?.total ?? 0) > 0 && history && (
        <GlassPanel title="Run history & quality" subtitle="How the factory is performing over time - grades are measured, not guaranteed">
          <div data-testid="history-grade" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "0.75rem" }}>
            {[
              { k: "Runs", v: String(history.grade.total) },
              { k: "Ready for PR", v: pct(history.grade.readyRate) },
              { k: "First-pass", v: pct(history.grade.firstPassRate) },
              { k: "Blocked", v: pct(history.grade.blockRate) },
              { k: "Escalated", v: pct(history.grade.escalationRate) },
            ].map((t) => (
              <div key={t.k} style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, padding: "0.6rem 0.75rem" }}>
                <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>{t.k}</div>
                <div style={{ fontSize: "1.3rem", fontWeight: 700, marginTop: "0.2rem" }}>{t.v}</div>
              </div>
            ))}
          </div>

          {history.drift.length > 0 && (
            <div data-testid="history-drift" style={{ marginTop: "0.9rem", padding: "0.6rem 0.75rem", borderRadius: 8, border: "1px solid var(--wp-error, #ef4444)", background: "color-mix(in srgb, var(--wp-error, #ef4444) 10%, transparent)" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--wp-error, #ef4444)", textTransform: "uppercase", letterSpacing: "0.03em" }}>Drift detected</div>
              {history.drift.map((d) => (
                <div key={d.model} style={{ fontSize: "0.82rem", marginTop: "0.3rem" }}>
                  {d.model}: ready-for-PR fell from {pct(d.priorReadyRate)} to {pct(d.recentReadyRate)} (down {pct(d.drop)}, n={d.priorN}&rarr;{d.recentN})
                </div>
              ))}
            </div>
          )}

          <div data-testid="history-runs" style={{ marginTop: "0.9rem", display: "grid", gap: "0.35rem" }}>
            {history.runs.slice(0, 15).map((r, i) => {
              const oc = OUTCOME[r.finalOutcome];
              const open = openRun === i;
              const canOpen = Boolean(r.diff);
              return (
                <div key={`${r.ref}-${i}`} style={{ borderRadius: 6, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", overflow: "hidden" }}>
                  <button
                    type="button"
                    data-testid={`history-run-${i}`}
                    aria-expanded={open}
                    onClick={() => setOpenRun(open ? null : i)}
                    title={canOpen ? "Show the code change" : "No stored diff for this run"}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.82rem", padding: "0.45rem 0.6rem", background: "transparent", border: "none", color: "var(--wp-text, #e6e9ef)", cursor: "pointer", textAlign: "left" }}
                  >
                    <span aria-hidden style={{ color: "var(--wp-text-dim)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s", display: "inline-block" }}>&rsaquo;</span>
                    <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.ref}</span>
                    <span style={{ color: "var(--wp-text-dim)" }}>{r.model}</span>
                    {r.repo && (
                      <span data-testid={`history-run-repo-${i}`} title={`Built against ${r.repo}`} style={{ fontSize: "0.7rem", padding: "0.05rem 0.4rem", borderRadius: 4, background: "var(--wp-surface-1, #12141a)", border: "1px solid var(--wp-border, #2a2f3a)", color: "var(--wp-text-dim)" }}>
                        {r.repo === "(self)" ? "self" : r.repo.split("/").pop()}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                      <StatusPill status={r.status} tone={r.status === "ready_for_pr" ? "success" : "warning"} label={r.status === "ready_for_pr" ? "Ready for PR" : "Needs human"} size="sm" />
                      <StatusPill status={r.finalOutcome} tone={oc.tone} label={oc.label} size="sm" />
                      {r.attempts > 0 ? <span style={{ color: "var(--wp-text-dim)", fontSize: "0.76rem" }}>{r.attempts} repair{r.attempts === 1 ? "" : "s"}</span> : null}
                    </span>
                  </button>
                  {open && (
                    <div data-testid={`history-run-detail-${i}`} style={{ borderTop: "1px solid var(--wp-border, #2a2f3a)", padding: "0.6rem 0.7rem" }}>
                      {r.reason && <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "var(--wp-text-dim)", lineHeight: 1.45 }}><strong style={{ color: "var(--wp-text, #e6e9ef)" }}>Gate verdict:</strong> {r.reason}</p>}
                      {r.diff ? (
                        <>
                          <div style={{ margin: 0, padding: "0.5rem 0", background: "#0d1117", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, overflowX: "auto", maxHeight: 360, fontSize: "0.78rem", fontFamily: "ui-monospace, SFMono-Regular, monospace", lineHeight: 1.5 }}>
                            {r.diff.split("\n").map((line, li) => (
                              <div key={li} style={{ padding: "0 0.8rem", whiteSpace: "pre", color: diffLineColor(line), background: line.startsWith("+") && !line.startsWith("+++") ? "rgba(63,185,80,0.08)" : line.startsWith("-") && !line.startsWith("---") ? "rgba(248,81,73,0.08)" : "transparent" }}>
                                {line || " "}
                              </div>
                            ))}
                          </div>
                          {r.diffTruncated && <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>Diff truncated for display; the full change is on the pull request.</p>}
                        </>
                      ) : (
                        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--wp-text-dim)" }}>No stored code change for this run (recorded before diffs were persisted).</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </GlassPanel>
      )}

      <WatchedReposPanel />

      <GlassPanel title="Audit evidence" subtitle="Verifiable, not just visible - re-check the tamper-evident record of every gate decision">
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center", marginBottom: audit ? "0.85rem" : 0 }}>
          <button type="button" data-testid="verify-audit" onClick={() => void verifyAudit()} disabled={auditLoading} style={btnStyle(auditLoading)}>
            {auditLoading ? "Verifying…" : audit ? "Re-verify" : "Verify the audit chain"}
          </button>
          {audit && (
            <button type="button" data-testid="download-audit" onClick={downloadAudit} style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, color: "var(--wp-text, #e6e9ef)", padding: "0.55rem 1rem", fontSize: "0.85rem", cursor: "pointer" }}>
              Download evidence (JSON)
            </button>
          )}
        </div>
        {auditError && <p role="alert" style={{ color: "var(--wp-error, #ef4444)", fontSize: "0.85rem", margin: 0 }}>{auditError}</p>}
        {audit && (
          <div data-testid="audit-result">
            <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.7rem 0.9rem", borderRadius: 10, border: `1px solid ${audit.verification.ok ? "#30a46c" : "#ef4444"}`, background: `color-mix(in srgb, ${audit.verification.ok ? "#30a46c" : "#ef4444"} 12%, transparent)` }}>
              <span aria-hidden style={{ width: 12, height: 12, borderRadius: "50%", background: audit.verification.ok ? "#30a46c" : "#ef4444", boxShadow: `0 0 9px 1px ${audit.verification.ok ? "#30a46c" : "#ef4444"}` }} />
              <span data-testid="audit-verdict" style={{ fontWeight: 700, color: "var(--wp-text, #e6e9ef)" }}>
                {audit.verification.ok
                  ? `Tamper-evident chain verified - ${audit.verification.verifiedCount.toLocaleString()} decisions, unbroken`
                  : `Chain broken at decision #${audit.verification.brokenAtSeq}`}
              </span>
            </div>
            <p style={{ margin: "0.6rem 0 0.4rem", fontSize: "0.72rem", color: "var(--wp-text-dim)", lineHeight: 1.45 }}>
              Each decision&rsquo;s hash was recomputed here from the prior decision&rsquo;s hash plus its stored payload. Any altered row breaks the chain. Download the full record to verify it yourself or hand it to an auditor.
            </p>
            <div data-testid="audit-entries" style={{ display: "grid", gap: "0.3rem", marginTop: "0.4rem" }}>
              {audit.entries.slice(0, 8).map((e) => (
                <div key={e.seq} style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.8rem", padding: "0.35rem 0.55rem", borderRadius: 6, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)" }}>
                  <span style={{ color: "var(--wp-text-dim)", fontVariantNumeric: "tabular-nums" }}>#{e.seq}</span>
                  <span style={{ fontWeight: 600 }}>{e.rule_id}</span>
                  <span style={{ marginLeft: "auto", color: e.effective_outcome === "block" ? "#ef4444" : e.effective_outcome === "escalate" ? "#f5a623" : "#30a46c" }}>{e.effective_outcome}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
