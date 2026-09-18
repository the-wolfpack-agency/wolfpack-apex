"use client";

/**
 * Forcefield for the Web - the watch-and-report dashboard.
 *
 * Shows how the workspace's sites handled agent traffic: known agents welcomed,
 * decoy trips caught, weak signals reported, and requests blocked. Reads its own
 * numbers from GET /api/forcefield-web/protection (a rollup over the inspection
 * event log). Watch-first: the numbers describe what was observed and recorded;
 * "blocked" appears only where a site graduated to enforce mode.
 *
 * Truthful by construction: counts only, an honest empty state before any
 * traffic, and "at least" when the sample is capped. Auth: unauthenticated
 * users are redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader } from "@/components/console";

interface Report {
  inspected: number;
  welcomed: number;
  allowed: number;
  reported: number;
  blocked: number;
  decoyTrips: number;
  sampleCapped: boolean;
}

export default function ForcefieldWebPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/forcefield-web");
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/forcefield-web/protection");
      if (!res.ok) {
        setError("Could not load the protection report.");
        return;
      }
      const data = (await res.json()) as { report?: Report };
      setReport(data.report ?? null);
    } catch {
      setError("Could not load the protection report.");
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!ready) return null;

  const r = report;
  const atLeast = r?.sampleCapped ? "at least " : "";
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
    gap: "0.9rem",
  };

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="forcefield-web">
      <SectionHeader
        title="Forcefield for the Web"
        subtitle="How your sites handled agent traffic: who was welcomed, what was trapped, and what was turned away."
      />

      {error && <p style={{ color: "var(--wp-error, #e5484d)", fontSize: "0.9rem" }} data-testid="ffw-error">{error}</p>}

      {report === null && !error ? (
        <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="ffw-loading">Loading...</p>
      ) : r && r.inspected === 0 ? (
        <GlassPanel style={{ marginTop: "1rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--wp-text-dim, #b4bcc8)", lineHeight: 1.55 }} data-testid="ffw-empty">
            No agent traffic has been inspected yet. Once a site sends requests through Forcefield, this fills in with what was welcomed, reported, and blocked. Watch-first: nothing is turned away until you graduate a site to enforce mode.
          </p>
        </GlassPanel>
      ) : r ? (
        <>
          {r.sampleCapped && (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="ffw-capped">
              Showing recent activity. Totals are a lower bound, shown as &ldquo;at least&rdquo;.
            </p>
          )}

          <h3 style={{ margin: "1.5rem 0 0.75rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Agent traffic</h3>
          <div style={gridStyle} data-testid="ffw-metrics">
            <MetricTile label="Requests inspected" display={`${atLeast}${r.inspected}`} testId="ffw-inspected" />
            <MetricTile label="Agents welcomed" display={String(r.welcomed)} accent={r.welcomed ? "var(--wp-success, #30a46c)" : undefined} testId="ffw-welcomed" />
            <MetricTile label="Decoy trips" display={String(r.decoyTrips)} accent={r.decoyTrips ? "var(--wp-error, #e5484d)" : undefined} testId="ffw-trips" />
            <MetricTile label="Signals reported" display={String(r.reported)} accent={r.reported ? "var(--wp-warning, #f5a623)" : undefined} testId="ffw-reported" />
            <MetricTile label="Blocked" display={String(r.blocked)} accent={r.blocked ? "var(--wp-error, #e5484d)" : undefined} testId="ffw-blocked" />
            <MetricTile label="Visitors allowed" display={String(r.allowed)} testId="ffw-allowed" />
          </div>

          <GlassPanel style={{ marginTop: "1.75rem" }}>
            <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--wp-text-dim, #b4bcc8)", lineHeight: 1.55 }}>
              A decoy trip is the high-confidence signal: nothing legitimate follows an invisible, robots-disallowed honeypot. A &ldquo;reported&rdquo; signal is a weaker page-level hint, recorded but never blocked on its own. &ldquo;Blocked&rdquo; counts only requests a site in enforce mode actually turned away.
            </p>
          </GlassPanel>
        </>
      ) : null}
    </div>
  );
}
