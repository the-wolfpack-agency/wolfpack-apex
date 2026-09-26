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
interface PipelineRun {
  ref: string;
  status: "ready_for_pr" | "needs_human";
  diff: string;
  review: CodeReview;
  remediation: { status: string; attempts: unknown[]; repairerLineage: string | null; reason: string };
  conformance: { conforms: boolean; findings: unknown[] };
  openQuestions: unknown[];
}
interface PipelineResponse {
  run?: PipelineRun;
  approvalId?: string | null;
  executor?: Executor | null;
  error?: string;
}

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
  const [prompt, setPrompt] = useState("");
  const [executorPin, setExecutorPin] = useState("");
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [executor, setExecutor] = useState<Executor | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/ai-code");
      return;
    }
    setReady(true);
  }, [router]);

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
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/pipeline", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          ref: ref.trim() || "factory",
          prompt: prompt.trim(),
          executorProviderPin: executorPin.trim() || undefined,
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
    } catch {
      setError("Network error - the factory did not run.");
    } finally {
      setRunning(false);
    }
  }, [ref, prompt, executorPin]);

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

      {run && v && (
        <>
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
    </div>
  );
}
