"use client";

/**
 * Code Governance overview - the trust surface for EVERYONE, not just engineers.
 *
 * The Secure Agent gates every AI-authored change behind the scenes: it scans for
 * secrets and known vulnerability classes, has a model of a DIFFERENT family
 * review the findings, and a deterministic policy decides allow / needs-review /
 * block. This page makes that visible in plain language - what gets checked, how
 * many changes were governed, and what the gate caught - so a non-engineer can
 * see the product doing its job.
 *
 * Read-only over the workspace's own review history (GET /api/admin/ai-code/review).
 * Auth: unauthenticated users are redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, StatusPill, SectionHeader, type SeverityTone } from "@/components/console";

type Outcome = "allow" | "escalate" | "block";

interface ReviewRecord {
  id: string;
  ref: string;
  author: string;
  outcome: Outcome;
  highestSeverity: string;
  findingCount: number;
  createdAt: string;
}

const OUTCOME: Record<Outcome, { label: string; tone: SeverityTone }> = {
  block: { label: "Blocked", tone: "error" },
  escalate: { label: "Needs review", tone: "warning" },
  allow: { label: "Allowed", tone: "success" },
};

/** The plain-language checklist every change goes through. */
const CHECKS: { title: string; detail: string }[] = [
  { title: "Secrets & credentials", detail: "No API keys, tokens or reset links may reach the code or the logs." },
  { title: "Known vulnerability classes", detail: "Injection, weak crypto, disabled TLS, unsafe HTML and more, CWE-classified." },
  { title: "Independent review", detail: "A model of a different family confirms each finding, so one vendor never marks its own homework." },
  { title: "Policy gate", detail: "A deterministic rule - not a model - decides allow, needs-review, or block. It fails closed." },
];

function fmtDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleDateString();
}

export default function CodeGovernancePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [reviews, setReviews] = useState<ReviewRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/ai-code/overview");
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/ai-code/review");
      if (!res.ok) {
        setError("Could not load the governance history.");
        setReviews([]);
        return;
      }
      const data = (await res.json()) as { reviews?: ReviewRecord[] };
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
    } catch {
      setError("Could not load the governance history.");
      setReviews([]);
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!ready) return null;

  const list = reviews ?? [];
  const governed = list.length;
  const blocked = list.filter((r) => r.outcome === "block").length;
  const needsReview = list.filter((r) => r.outcome === "escalate").length;
  const caught = list.filter((r) => r.outcome !== "allow").reduce((n, r) => n + (r.findingCount || 0), 0);

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="code-governance">
      <SectionHeader
        title="Code governance"
        subtitle="Every AI-authored change is checked before it can merge. Here is what that catches."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", margin: "1.25rem 0" }}>
        <MetricTile label="Changes governed" display={String(governed)} testId="metric-governed" />
        <MetricTile label="Blocked" display={String(blocked)} accent={blocked ? "var(--wp-error, #e5484d)" : undefined} testId="metric-blocked" />
        <MetricTile label="Sent for human review" display={String(needsReview)} accent={needsReview ? "var(--wp-warning, #f5a623)" : undefined} testId="metric-review" />
        <MetricTile label="Risks caught" display={String(caught)} accent={caught ? "var(--wp-error, #e5484d)" : "var(--wp-success, #30a46c)"} testId="metric-caught" />
      </div>

      <GlassPanel style={{ marginBottom: "1.25rem" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>
          What every change is checked for
        </h3>
        <div style={{ display: "grid", gap: "0.6rem" }}>
          {CHECKS.map((c) => (
            <div key={c.title} style={{ display: "flex", gap: "0.7rem", alignItems: "flex-start" }} data-testid="check-row">
              <StatusPill status="checked" tone="success" label="Checked" />
              <div>
                <div style={{ fontWeight: 600, color: "var(--wp-text, #e6e9ef)" }}>{c.title}</div>
                <div style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.88rem" }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Recent changes</h3>
        {error && (
          <p style={{ color: "var(--wp-error, #e5484d)", fontSize: "0.9rem" }} data-testid="gov-error">{error}</p>
        )}
        {reviews === null ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="gov-loading">Loading...</p>
        ) : list.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="gov-empty">
            No changes have been governed yet. Runs appear here as the gate reviews them.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {list.map((r) => {
              const o = OUTCOME[r.outcome] ?? OUTCOME.allow;
              return (
                <div
                  key={r.id}
                  data-testid="gov-row"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem",
                    padding: "0.55rem 0.7rem", background: "var(--wp-surface-2, #171a21)",
                    border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "var(--wp-text, #e6e9ef)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.ref}
                    </div>
                    <div style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.82rem" }}>
                      {r.author} · {fmtDate(r.createdAt)}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flex: "0 0 auto" }}>
                    <span style={{ color: "var(--wp-text-dim, #b4bcc8)", fontSize: "0.82rem" }}>
                      {r.findingCount} {r.findingCount === 1 ? "finding" : "findings"}
                    </span>
                    <StatusPill status={r.outcome} tone={o.tone} label={o.label} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
