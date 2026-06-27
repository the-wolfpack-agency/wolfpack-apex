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
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";

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
    </div>
  );
}
