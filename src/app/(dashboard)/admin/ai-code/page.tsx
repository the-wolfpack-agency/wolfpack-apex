"use client";

/**
 * /admin/ai-code - the Code Gate. Paste an AI-authored diff, get the gate's
 * verdict: block / needs-review / allow, the findings behind it, and (optionally)
 * an independent-family model's second opinion on each one.
 *
 * The gate DECIDES deterministically; the judge only advises. This page makes
 * that visible: the verdict pill is the gate, the judge column is a separate,
 * clearly-labeled opinion - never dressed up as the decision.
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
interface Result {
  ref: string;
  author: string;
  findings: Finding[];
  verdict: { outcome: Outcome; highestSeverity: string; reason: string; ruleId: string };
  bySeverity: Record<string, number>;
  judgments?: Judgment[];
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

export default function CodeGatePage() {
  const router = useRouter();
  const [ref, setRef] = useState("");
  const [authorModel, setAuthorModel] = useState("");
  const [diff, setDiff] = useState("");
  const [judge, setJudge] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
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

  const review = useCallback(async () => {
    if (!diff.trim()) {
      setError("Paste a diff to review.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/review", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ ref: ref.trim() || "manual", diff, judge, authorModel: authorModel.trim() || undefined }),
      });
      const body = (await res.json()) as { result?: Result; error?: string };
      if (!res.ok || !body.result) {
        setError(body.error ? `The gate could not run: ${body.error}` : `Request failed (${res.status}).`);
        setResult(null);
        return;
      }
      setResult(body.result);
    } catch {
      setError("Network error - the gate did not run.");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [ref, authorModel, diff, judge]);

  if (!ready) return null;

  const v = result ? OUTCOME[result.verdict.outcome] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <SectionHeader
        as="h1"
        eyebrow="Secure Agent"
        title="Code gate"
        subtitle="Paste an AI-authored diff. The deterministic gate decides block / needs-review / allow; an independent-family model can add a second opinion on each finding."
      />

      <GlassPanel title="Review a diff">
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 12rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Ref (PR / commit)</span>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PR-123" aria-label="Ref" style={inputStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 12rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Author model (for the judge)</span>
            <input value={authorModel} onChange={(e) => setAuthorModel(e.target.value)} placeholder="e.g. gpt-4o" aria-label="Author model" style={inputStyle} />
          </label>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginTop: "0.75rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Unified diff</span>
          <textarea
            value={diff}
            onChange={(e) => setDiff(e.target.value)}
            placeholder={"diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,1 @@\n+export const sum = (a, b) => a + b;"}
            aria-label="Unified diff"
            rows={10}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
            <input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} aria-label="Independent judge" />
            Get an independent model&apos;s second opinion
          </label>
          <button type="button" onClick={() => void review()} disabled={running} style={btnStyle(running)}>
            {running ? "Reviewing…" : "Review"}
          </button>
        </div>
        {error && (
          <p role="alert" style={{ marginTop: "0.75rem", color: "var(--wp-error, #ef4444)", fontSize: "0.9rem" }}>
            {error}
          </p>
        )}
      </GlassPanel>

      {result && v && (
        <>
          <GlassPanel title="Verdict" subtitle={result.ref}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <StatusPill status={result.verdict.outcome} tone={v.tone} label={v.label} />
              <span style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem" }}>{result.verdict.reason}</span>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <MetricTile value={result.findings.length} label="Findings" />
              <MetricTile value={result.bySeverity.critical ?? 0} label="Critical" />
              <MetricTile value={result.bySeverity.high ?? 0} label="High" />
            </div>
          </GlassPanel>

          <GlassPanel title="Findings">
            {result.findings.length === 0 ? (
              <p style={{ color: "var(--wp-text-dim)" }}>No security findings in the added lines.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {result.findings.map((f, i) => (
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

          {result.judgments && result.judgments.length > 0 && (
            <GlassPanel title="Independent judge" subtitle="A different-family model's opinion - advisory, never the decision">
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {result.judgments.map((j, i) => (
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
    </div>
  );
}
