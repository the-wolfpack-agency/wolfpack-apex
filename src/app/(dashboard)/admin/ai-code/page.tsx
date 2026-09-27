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
  mode?: string;
  cost?: RunCost;
  error?: string;
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
}
interface ModelGrade { model: string; n: number; readyRate: number; firstPassRate: number; blockRate: number }
interface Grade { total: number; readyRate: number; firstPassRate: number; blockRate: number; escalationRate: number; byModel: ModelGrade[] }
interface DriftFlag { model: string; priorReadyRate: number; recentReadyRate: number; drop: number; priorN: number; recentN: number }
interface HistoryData { runs: RunSummary[]; grade: Grade; drift: DriftFlag[] }

const pct = (n: number): string => `${Math.round(n * 100)}%`;

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
  const [executorPin, setExecutorPin] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [executor, setExecutor] = useState<Executor | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [invariants, setInvariants] = useState<InvariantDecision | null>(null);
  const [deepScan, setDeepScan] = useState<DeepScanSummary | null>(null);
  const [cost, setCost] = useState<RunCost | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState<HistoryData | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/history?limit=50");
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

  const generate = useCallback(async () => {
    if (!prompt.trim()) {
      setError("Describe the change you want the factory to build.");
      return;
    }
    setRunning(true);
    setError(null);
    setRun(null);
    setExecutor(null);
    setApprovalId(null);
    setInvariants(null);
    setDeepScan(null);
    setCost(null);
    setPrUrl(null);
    setApproveError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/pipeline", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          ref: ref.trim() || "factory",
          repo: repo.trim() || undefined,
          prompt: prompt.trim(),
          executorProviderPin: executorPin.trim() || undefined,
          // Confirmed/changed assumptions from the clarifier (empty on first run).
          answers: Object.keys(answers).length > 0 ? answers : undefined,
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
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/approvals/${approvalId}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ action: "approve" }),
      });
      const body = (await res.json()) as { ok?: boolean; outcome?: { ok?: boolean; url?: string; reason?: string }; error?: string };
      if (res.ok && body.outcome?.ok && body.outcome.url) {
        setPrUrl(body.outcome.url);
      } else {
        setApproveError(body.outcome?.reason || body.error || "Approval did not open a PR.");
      }
    } catch {
      setApproveError("Network error - the approval did not run.");
    } finally {
      setApproving(false);
    }
  }, [approvalId]);

  if (!ready) return null;

  const v = run ? OUTCOME[run.review.verdict.outcome] : null;
  const reroutes = run ? run.remediation.attempts.length : 0;

  return (
    <div data-testid="ai-code-page" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <SectionHeader
        as="h1"
        eyebrow="Secure Agent"
        title="Code factory"
        subtitle="Describe a change. A model authors it, the deterministic gate decides block / needs-review / allow, an independent-family model advises, and a non-allow verdict re-routes to a different model. It reaches a pull request only when the gate allows."
      />

      <GlassPanel title="Build a change">
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 14rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Target repo</span>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="the-wolfpack-agency/wolfpack-apex" aria-label="Target repo" data-testid="repo-input" style={inputStyle} />
          </label>
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
                  <button type="button" data-testid="clarifier-rerun" onClick={() => void generate()} disabled={running} style={btnStyle(running)}>
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

          {(invariants || deepScan) && (
            <GlassPanel title="Governance" subtitle="Deterministic engineering invariants + full deep static scan">
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
              <p data-testid="handoff-status" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", fontWeight: 600 }}>
                {approvalId
                  ? "Ready for PR - handoff captured for human approval; the factory never merges."
                  : run.status === "needs_human"
                    ? "Needs human - the gate did not allow this change."
                    : `Withheld from PR handoff: ${invariants?.wouldBlock ? invariants.ruleId : deepScan?.blocking ? "critical security finding" : "needs human"}.`}
              </p>

              {/* The human-in-the-loop step: approve to open the real PR, then link it. */}
              {approvalId && !prUrl && (
                <div style={{ marginTop: "0.75rem" }}>
                  <button type="button" onClick={() => void approve()} disabled={approving} style={btnStyle(approving)} data-testid="approve-open-pr">
                    {approving ? "Opening PR…" : "Approve & open PR"}
                  </button>
                  {approveError && (
                    <p role="alert" style={{ margin: "0.5rem 0 0", color: "var(--wp-error, #ef4444)", fontSize: "0.85rem" }}>
                      {approveError}
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

          {run.diff && (
            <GlassPanel title="Authored change">
              <details>
                <summary style={{ cursor: "pointer", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                  View the diff the gate governed
                </summary>
                <pre
                  aria-label="Authored diff"
                  style={{
                    marginTop: "0.6rem",
                    padding: "0.75rem",
                    background: "var(--wp-surface-2, #171a21)",
                    border: "1px solid var(--wp-border, #2a2f3a)",
                    borderRadius: 8,
                    overflowX: "auto",
                    fontSize: "0.8rem",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {run.diff}
                </pre>
              </details>
            </GlassPanel>
          )}
        </>
      )}

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
            {history.runs.slice(0, 15).map((r, i) => (
              <div key={`${r.ref}-${i}`} style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.82rem", padding: "0.4rem 0.55rem", borderRadius: 6, background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)" }}>
                <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.ref}</span>
                <span style={{ color: "var(--wp-text-dim)" }}>{r.model}</span>
                <span style={{ marginLeft: "auto", color: r.status === "ready_for_pr" ? "var(--wp-success, #30a46c)" : "var(--wp-warning, #f5a623)" }}>{r.status === "ready_for_pr" ? "ready" : "needs human"}</span>
                <span style={{ color: r.finalOutcome === "block" ? "var(--wp-error, #ef4444)" : "var(--wp-text-dim)" }}>{r.finalOutcome}</span>
                {r.attempts > 0 ? <span style={{ color: "var(--wp-text-dim)" }}>{r.attempts} repair{r.attempts === 1 ? "" : "s"}</span> : null}
              </div>
            ))}
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
