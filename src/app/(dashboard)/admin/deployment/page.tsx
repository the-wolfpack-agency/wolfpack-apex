"use client";

/**
 * /admin/deployment - deployment readiness gate review surface.
 *
 * Before a new client deployment goes live, an operator runs this page: it calls
 * GET /api/admin/deployment-readiness, which verifies every Vercel env blocker is
 * present AND that Postgres / Qdrant / Neo4j / GitHub are reachable. The page
 * renders one Ready / Not ready row per check, a top-line banner, and splits
 * critical (gates launch) from advisory (degraded but running) so the operator
 * knows exactly what must be fixed before launch vs. what merely disables a
 * feature. No secret values are ever shown - only present/absent + reachability.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). Unauthenticated users are redirected to /login, never shown
 * a blank state.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  GlassPanel,
  MetricTile,
  StatusPill,
  SectionHeader,
  ConsoleGrid,
  type SeverityTone,
} from "@/components/console";
import type {
  ReleaseGateStatus,
  BlockingChange,
  ReleaseBlockState,
} from "@/lib/deploy/release-gate";
import type { MergePlan, MergeStep } from "@/lib/deploy/merge-plan";
import { DeploymentPipelinePanel } from "@/components/deploy/DeploymentPipelinePanel";

interface ReadinessCheck {
  name: string;
  pass: boolean;
  detail: string;
  critical: boolean;
}

interface ReadinessResult {
  ok: boolean;
  checks: ReadinessCheck[];
}

/**
 * Map a release-gate state to a command-center tone. This is the one place the
 * gate's vocabulary becomes colour, so an operator reads the same severity here
 * as everywhere else in the console.
 *   awaiting_approval               -> warning
 *   checks_failing / merge_conflict -> error
 *   checks_running                  -> info
 *   ready_to_merge                  -> success
 */
const STATE_TONE: Record<ReleaseBlockState, SeverityTone> = {
  awaiting_approval: "warning",
  checks_failing: "error",
  merge_conflict: "error",
  checks_running: "info",
  ready_to_merge: "success",
};

/** Short, human label for each state shown inside the pill. */
const STATE_LABEL: Record<ReleaseBlockState, string> = {
  awaiting_approval: "Awaiting approval",
  checks_failing: "Checks failing",
  merge_conflict: "Merge conflict",
  checks_running: "Checks running",
  ready_to_merge: "Ready to promote",
};

/** "blocking for 3.2h" / "blocking for 0.5h" - plain-language age. */
function blockingForLabel(ageHours: number): string {
  return `blocking for ${ageHours.toFixed(1)}h`;
}

/**
 * One blocking-change row. Owns its own promote lifecycle (confirm -> spinner
 * -> success/failure) so a slow merge on one row never freezes the others.
 * Only a ready_to_merge change renders the Promote button; everything else is
 * read-only with its plain-language reason.
 */
function BlockingRow({
  change,
  onPromoted,
}: {
  change: BlockingChange;
  onPromoted: () => void;
}) {
  const [promoting, setPromoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const promote = useCallback(async () => {
    setPromoting(true);
    setConfirming(false);
    setResult(null);
    try {
      const res = await fetchWithRefresh("/api/admin/deployment/release-gate/promote", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ prNumber: change.number }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        mergedSha?: string;
      };
      if (res.ok && data.ok) {
        setResult({ ok: true, message: "Promoted - deploying now." });
        // Let the operator see the success, then refresh the gate.
        setTimeout(onPromoted, 1200);
      } else {
        setResult({
          ok: false,
          message: data.reason ?? `Could not promote (HTTP ${res.status}).`,
        });
      }
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setPromoting(false);
    }
  }, [change.number, onPromoted]);

  const tone = STATE_TONE[change.state];

  return (
    <div
      data-testid={`blocking-row-${change.number}`}
      data-state={change.state}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "0.85rem 1rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #242a36)",
        borderRadius: "0.6rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <StatusPill
          status={change.state}
          tone={tone}
          label={STATE_LABEL[change.state]}
          testId={`blocking-pill-${change.number}`}
        />
        <a
          href={change.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`blocking-link-${change.number}`}
          style={{ fontWeight: 600, color: "var(--wp-text, #e9edf4)", textDecoration: "none" }}
        >
          {change.title}{" "}
          <span style={{ color: "var(--wp-text-muted, #929cad)", fontWeight: 500 }}>
            #{change.number}
          </span>
        </a>
        <span style={{ flex: 1 }} />
        {change.state === "ready_to_merge" && !result?.ok && (
          confirming ? (
            <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
              <button
                type="button"
                data-testid={`promote-confirm-${change.number}`}
                disabled={promoting}
                onClick={() => void promote()}
                style={{
                  padding: "0.35rem 0.8rem",
                  borderRadius: "0.4rem",
                  border: "none",
                  cursor: promoting ? "default" : "pointer",
                  fontWeight: 600,
                  color: "#0b0b0c",
                  background: "var(--wp-success, #22c55e)",
                  opacity: promoting ? 0.6 : 1,
                }}
              >
                {promoting ? "Promoting…" : "Confirm promote"}
              </button>
              <button
                type="button"
                data-testid={`promote-cancel-${change.number}`}
                disabled={promoting}
                onClick={() => setConfirming(false)}
                style={{
                  padding: "0.35rem 0.6rem",
                  borderRadius: "0.4rem",
                  border: "1px solid var(--wp-dark-border, #242a36)",
                  cursor: "pointer",
                  fontWeight: 600,
                  color: "var(--wp-text-dim, #b4bcc8)",
                  background: "transparent",
                }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid={`promote-${change.number}`}
              onClick={() => setConfirming(true)}
              style={{
                padding: "0.35rem 0.9rem",
                borderRadius: "0.4rem",
                border: "none",
                cursor: "pointer",
                fontWeight: 600,
                color: "#0b0b0c",
                background: "var(--wp-success, #22c55e)",
              }}
            >
              Promote to production
            </button>
          )
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.83rem" }}>
        <span data-testid={`blocking-reason-${change.number}`} style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>
          {change.reason}
        </span>
        <span style={{ color: "var(--wp-text-muted, #929cad)" }}>·</span>
        <span style={{ color: "var(--wp-text-muted, #929cad)" }}>{change.author}</span>
        <span style={{ color: "var(--wp-text-muted, #929cad)" }}>·</span>
        <span data-testid={`blocking-age-${change.number}`} style={{ color: "var(--wp-text-muted, #929cad)" }}>
          {blockingForLabel(change.ageHours)}
        </span>
      </div>
      {result && (
        <div
          data-testid={`promote-result-${change.number}`}
          style={{
            fontSize: "0.83rem",
            fontWeight: 600,
            color: result.ok ? "var(--wp-success, #22c55e)" : "var(--wp-error, #ef4444)",
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}

/**
 * Recommended approval order: the operator-facing fix for "which do I merge
 * first?" Renders the ordered, annotated promotion sequence so a human gate
 * promotes in a conflict-free order instead of guessing (which is what caused the
 * pile-up of merge conflicts). Independent changes are flagged safe-any-order;
 * overlapping ones say which earlier change to land first and on which files.
 */
function MergePlanPanel({ plan }: { plan: MergePlan }) {
  const ordered = plan.steps.filter((s) => s.ready);
  if (ordered.length === 0) return null;

  return (
    <div
      data-testid="merge-plan"
      style={{
        marginBottom: "1.1rem",
        padding: "0.9rem 1rem",
        borderRadius: "0.6rem",
        background: "color-mix(in srgb, var(--wp-info, #3b82f6) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--wp-info, #3b82f6) 32%, transparent)",
      }}
    >
      <div style={{ fontWeight: 700, color: "var(--wp-text, #e9edf4)", marginBottom: "0.5rem" }}>
        Recommended approval order
      </div>
      {plan.degraded ? (
        <div data-testid="merge-plan-degraded" style={{ marginBottom: "0.6rem", fontSize: "0.82rem", fontWeight: 600, color: "var(--wp-warning, #f97316)" }}>
          Overlap analysis incomplete - order is best-effort. {plan.degraded.detail}
        </div>
      ) : !plan.hasOverlaps ? (
        <div data-testid="merge-plan-independent" style={{ marginBottom: "0.6rem", fontSize: "0.82rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          These changes touch no shared files - promote them in any order, no conflicts expected.
        </div>
      ) : (
        <div style={{ marginBottom: "0.6rem", fontSize: "0.82rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          Promote in this order to avoid conflicts. Promote one, let it deploy, then the next.
        </div>
      )}
      <ol data-testid="merge-plan-steps" style={{ margin: 0, paddingLeft: "1.4rem", display: "grid", gap: "0.45rem" }}>
        {ordered.map((step: MergeStep) => (
          <li key={step.number} data-testid={`merge-step-${step.number}`} data-order={step.order} style={{ fontSize: "0.85rem" }}>
            <a
              href={step.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontWeight: 600, color: "var(--wp-text, #e9edf4)", textDecoration: "none" }}
            >
              {step.title} <span style={{ color: "var(--wp-text-muted, #929cad)", fontWeight: 500 }}>#{step.number}</span>
            </a>
            <div data-testid={`merge-step-note-${step.number}`} style={{ color: "var(--wp-text-dim, #b4bcc8)", marginTop: "0.15rem" }}>
              {step.note}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Production release gate section: the operator-facing answer to "what is
 * blocking a deploy to production right now, and what can I ship in one click?"
 * Fetches the gate via fetchWithRefresh; honours the honest-degrade contract
 * (degraded => explicit warning, NEVER a false all-clear); promotes ready code.
 */
function ReleaseGateSection() {
  const [gate, setGate] = useState<ReleaseGateStatus | null>(null);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/deployment/release-gate");
      if (!res.ok) throw new Error(`Failed to read the release gate (HTTP ${res.status})`);
      const data = (await res.json()) as { ok: boolean; gate: ReleaseGateStatus; plan: MergePlan | null };
      setGate(data.gate);
      setPlan(data.plan ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const blocking = gate?.blocking ?? [];
  const degraded = gate?.degraded;

  return (
    <GlassPanel testId="release-gate-section" style={{ marginTop: "2rem" }} glow="gold">
      <SectionHeader
        as="h2"
        eyebrow="Production release gate"
        title="What is blocking a deploy"
        subtitle={
          gate
            ? `Targeting ${gate.productionBranch}. Built changes waiting to ship to production.`
            : "Built changes waiting to ship to production."
        }
        actions={
          <button
            type="button"
            data-testid="release-gate-refresh"
            disabled={loading}
            onClick={() => void load()}
            style={{
              padding: "0.4rem 0.85rem",
              borderRadius: "0.4rem",
              border: "1px solid var(--wp-dark-border, #242a36)",
              cursor: loading ? "default" : "pointer",
              fontWeight: 600,
              color: "var(--wp-text, #e9edf4)",
              background: "transparent",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
        }
      />

      {loading ? (
        <p data-testid="release-gate-loading" style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>
          Checking the production release gate…
        </p>
      ) : error ? (
        <p data-testid="release-gate-error" style={{ color: "var(--wp-error, #ef4444)" }}>
          {error}
        </p>
      ) : (
        <>
          {degraded && (
            <div
              data-testid="release-gate-degraded"
              style={{
                padding: "0.85rem 1rem",
                marginBottom: "1rem",
                borderRadius: "0.5rem",
                fontWeight: 600,
                color: "var(--wp-warning, #f97316)",
                background: "color-mix(in srgb, var(--wp-warning, #f97316) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--wp-warning, #f97316) 38%, transparent)",
              }}
            >
              Could not reach GitHub to check - status unknown. {degraded.detail}
            </div>
          )}

          {!degraded && (
            <ConsoleGrid minColWidth={180} style={{ marginBottom: "1.1rem" }}>
              <MetricTile
                testId="release-gate-blocking-count"
                value={blocking.length}
                label="Changes blocked from production"
                accent={blocking.length > 0 ? "var(--wp-warning, #f97316)" : "var(--wp-success, #22c55e)"}
              />
              <MetricTile
                testId="release-gate-ready-count"
                value={blocking.filter((c) => c.state === "ready_to_merge").length}
                label="Ready to promote now"
                accent="var(--wp-success, #22c55e)"
              />
            </ConsoleGrid>
          )}

          {!degraded && plan && <MergePlanPanel plan={plan} />}

          {!degraded && blocking.length === 0 ? (
            <p data-testid="release-gate-empty" style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>
              All changes are live in production.
            </p>
          ) : (
            <div data-testid="release-gate-rows" style={{ display: "grid", gap: "0.6rem" }}>
              {blocking.map((change) => (
                <BlockingRow key={change.number} change={change} onPromoted={() => void load()} />
              ))}
            </div>
          )}
        </>
      )}
    </GlassPanel>
  );
}

const OK_COLOR = "var(--wp-success, #22c55e)";
const FAIL_CRITICAL_COLOR = "var(--wp-error, #ef4444)";
const FAIL_ADVISORY_COLOR = "#f59e0b";

function CheckRow({ check }: { check: ReadinessCheck }) {
  const color = check.pass
    ? OK_COLOR
    : check.critical
      ? FAIL_CRITICAL_COLOR
      : FAIL_ADVISORY_COLOR;
  const label = check.pass ? "Ready" : check.critical ? "Not ready" : "Advisory";
  return (
    <div
      data-testid={`check-row-${check.name}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        flexWrap: "wrap",
        padding: "0.7rem 1rem",
        marginBottom: "0.5rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "0.5rem",
      }}
    >
      <span
        data-testid={`check-status-${check.name}`}
        style={{
          fontSize: "0.7rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          padding: "0.15rem 0.55rem",
          borderRadius: "0.35rem",
          color: "#0b0b0c",
          background: color,
        }}
      >
        {label}
      </span>
      <code style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--wp-text, #eee)" }}>
        {check.name}
      </code>
      {check.critical ? (
        <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--wp-error, #ef4444)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          critical
        </span>
      ) : (
        <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          advisory
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: "0.83rem", color: "var(--wp-text-dim, #aaa)" }}>{check.detail}</span>
    </div>
  );
}

export default function DeploymentReadinessPage() {
  const router = useRouter();
  const [result, setResult] = useState<ReadinessResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Gate every authenticated fetch (readiness AND release gate) behind a known
  // session so an unauthenticated visit redirects without firing a request.
  const [authed, setAuthed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/deployment-readiness");
      if (!res.ok) throw new Error(`Failed to run readiness check (HTTP ${res.status})`);
      const data = (await res.json()) as ReadinessResult;
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/deployment");
      return;
    }
    setAuthed(true);
    void load();
  }, [router, load]);

  const critical = result?.checks.filter((c) => c.critical) ?? [];
  const advisory = result?.checks.filter((c) => !c.critical) ?? [];
  const criticalFailures = critical.filter((c) => !c.pass).length;
  const advisoryFailures = advisory.filter((c) => !c.pass).length;

  return (
    <div data-testid="deployment-readiness-page" style={{ padding: "1.5rem", maxWidth: 920, margin: "0 auto", color: "var(--wp-text, #eee)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>Deployment readiness</h1>
        <span style={{ flex: 1 }} />
        <Link href="/admin/platform-scans" data-testid="back-to-scans" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
          ← Platform scans
        </Link>
      </div>
      <p style={{ marginTop: 0, marginBottom: "1rem", fontSize: "0.9rem", color: "var(--wp-text-muted, #6b7280)" }}>
        Verifies every required env var is set and that Postgres, Qdrant, Neo4j, and GitHub are reachable before this deployment goes live. No secret values are shown.
      </p>

      <div style={{ marginBottom: "1.2rem" }}>
        <button
          type="button"
          data-testid="rerun"
          disabled={loading}
          onClick={() => void load()}
          style={{
            padding: "0.45rem 1rem",
            borderRadius: "0.4rem",
            border: "none",
            cursor: loading ? "default" : "pointer",
            fontWeight: 600,
            color: "#0b0b0c",
            background: "var(--wp-gold, #f1c233)",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Checking…" : "Re-run check"}
        </button>
      </div>

      {loading ? (
        <p data-testid="readiness-loading" style={{ color: "var(--wp-text-dim, #aaa)" }}>Running readiness checks…</p>
      ) : error ? (
        <p data-testid="readiness-error" style={{ color: "var(--wp-error, #ef4444)" }}>{error}</p>
      ) : result ? (
        <>
          <div
            data-testid="readiness-banner"
            data-ready={result.ok ? "true" : "false"}
            style={{
              padding: "0.85rem 1rem",
              marginBottom: "1.2rem",
              borderRadius: "0.5rem",
              fontWeight: 700,
              color: "#0b0b0c",
              background: result.ok ? OK_COLOR : FAIL_CRITICAL_COLOR,
            }}
          >
            {result.ok
              ? "Ready to deploy - every critical check passed."
              : `Not ready - ${criticalFailures} critical check${criticalFailures === 1 ? "" : "s"} failing. Fix before going live.`}
            {advisoryFailures > 0 && (
              <span data-testid="advisory-note" style={{ display: "block", marginTop: "0.3rem", fontWeight: 600, fontSize: "0.82rem" }}>
                {advisoryFailures} advisory check{advisoryFailures === 1 ? "" : "s"} failing (degraded, not blocking).
              </span>
            )}
          </div>

          <h2 style={{ fontSize: "1rem", color: "var(--wp-gold, #f1c233)", marginBottom: "0.6rem" }}>Critical</h2>
          <div data-testid="critical-checks">
            {critical.length === 0 ? (
              <p data-testid="critical-empty" style={{ color: "var(--wp-text-dim, #aaa)" }}>No critical checks ran.</p>
            ) : (
              critical.map((c) => <CheckRow key={c.name} check={c} />)
            )}
          </div>

          <h2 style={{ fontSize: "1rem", color: "var(--wp-gold, #f1c233)", margin: "1.4rem 0 0.6rem" }}>Advisory</h2>
          <div data-testid="advisory-checks">
            {advisory.length === 0 ? (
              <p data-testid="advisory-empty" style={{ color: "var(--wp-text-dim, #aaa)" }}>No advisory checks ran.</p>
            ) : (
              advisory.map((c) => <CheckRow key={c.name} check={c} />)
            )}
          </div>
        </>
      ) : null}

      {authed && <ReleaseGateSection />}

      {/* The full pipeline: the release gate above shows what's blocking the
          next deploy; this shows every change's whole journey to production
          (CI -> merge -> build -> promote -> verify -> health), stitched across
          GitHub + Vercel + our own post-deploy checks. Gated on authed so it
          only mounts (and fetches) after the auth check, never on the redirect
          path. */}
      {authed && (
        <div style={{ marginTop: "2rem" }}>
          <DeploymentPipelinePanel testId="deployment-pipeline" />
        </div>
      )}
    </div>
  );
}
