"use client";

/**
 * Effectiveness - the "prove it works" surface for Secure Agent and Forcefield.
 *
 * Reads the workspace's own numbers from GET /api/admin/effectiveness (the
 * rollup over the real review store + canary-trip ledger + canary registry) and
 * states, in plain language, what the platform has actually done: how many
 * AI-authored changes it governed, how much bad code it caught, and how many
 * hostile agents a decoy contained. This is the evidence a client asks for.
 *
 * Truthful by construction (mirrors the rollup): counts only, no fabricated
 * rates; when the sample is capped it says "at least"; "governed" is kept
 * distinct from "blocked"/"contained". Auth: unauthenticated users are
 * redirected, never shown an empty shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader } from "@/components/console";

interface Report {
  sampleCapped: boolean;
  secureAgent: { changesGoverned: number; blocked: number; sentToHuman: number; allowed: number; risksCaught: number };
  forcefield: { decoysActive: number; trips: number; agentsContained: number };
  governance: { actionsGoverned: number; denied: number; escalated: number; transformed: number; allowed: number; wouldBlock: number; agentsActive: number };
  cost: { monthToDateUsd: number; measured: boolean };
  enforcement: { capabilityDenied: number; connectorScopeDenied: number; ceilingHits: number; conductDenied: number; total: number };
}

export default function EffectivenessPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/effectiveness");
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/effectiveness");
      if (!res.ok) {
        setError("Could not load the effectiveness report.");
        return;
      }
      const data = (await res.json()) as { report?: Report };
      setReport(data.report ?? null);
    } catch {
      setError("Could not load the effectiveness report.");
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!ready) return null;

  const sa = report?.secureAgent;
  const ff = report?.forcefield;
  const gov = report?.governance;
  const cost = report?.cost;
  const enf = report?.enforcement;
  // Actual month-to-date spend, or an explicit "not measured" when the cost view
  // could not be read - never a fabricated $0.
  const costDisplay = cost ? (cost.measured ? `$${cost.monthToDateUsd.toFixed(2)}` : "Not measured") : "$0.00";
  // A lower-bound prefix, only when the sample was capped (never overclaim a total).
  const atLeast = report?.sampleCapped ? "at least " : "";
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
    gap: "0.9rem",
  };

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="effectiveness">
      <SectionHeader
        title="Effectiveness"
        subtitle="What the governance has actually done for this workspace, from its own records."
      />

      {error && <p style={{ color: "var(--wp-error, #e5484d)", fontSize: "0.9rem" }} data-testid="eff-error">{error}</p>}
      {report === null && !error ? (
        <p style={{ color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="eff-loading">Loading...</p>
      ) : report ? (
        <>
          {report.sampleCapped && (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }} data-testid="eff-capped">
              Showing recent activity. Totals are a lower bound, shown as &ldquo;at least&rdquo;.
            </p>
          )}

          <h3 style={{ margin: "1.5rem 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Secure Agent</h3>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
            Every AI-authored change is checked before it can merge.
          </p>
          <div style={gridStyle} data-testid="eff-secure-agent">
            <MetricTile label="Changes governed" display={`${atLeast}${sa?.changesGoverned ?? 0}`} testId="eff-governed" />
            <MetricTile label="Blocked" display={String(sa?.blocked ?? 0)} accent={sa?.blocked ? "var(--wp-error, #e5484d)" : undefined} testId="eff-blocked" />
            <MetricTile label="Sent for human review" display={String(sa?.sentToHuman ?? 0)} accent={sa?.sentToHuman ? "var(--wp-warning, #f5a623)" : undefined} testId="eff-review" />
            <MetricTile label="Risks caught" display={String(sa?.risksCaught ?? 0)} accent={sa?.risksCaught ? "var(--wp-error, #e5484d)" : "var(--wp-success, #30a46c)"} testId="eff-risks" />
          </div>

          <h3 style={{ margin: "1.75rem 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Forcefield</h3>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
            Decoys nothing legitimate touches. A single touch contains the agent automatically.
          </p>
          <div style={gridStyle} data-testid="eff-forcefield">
            <MetricTile label="Active decoys" display={String(ff?.decoysActive ?? 0)} accent="var(--wp-success, #30a46c)" testId="eff-decoys" />
            <MetricTile label="Trips" display={`${atLeast}${ff?.trips ?? 0}`} accent={ff?.trips ? "var(--wp-error, #e5484d)" : undefined} testId="eff-trips" />
            <MetricTile label="Agents contained" display={String(ff?.agentsContained ?? 0)} accent={ff?.agentsContained ? "var(--wp-error, #e5484d)" : undefined} testId="eff-contained" />
          </div>

          <h3 style={{ margin: "1.75rem 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Per-action governance</h3>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
            Every agent action runs the gate before it happens. The gate decides allow, deny, transform, or escalate.
          </p>
          <div style={gridStyle} data-testid="eff-governance">
            <MetricTile label="Actions governed" display={`${atLeast}${gov?.actionsGoverned ?? 0}`} testId="eff-actions-governed" />
            <MetricTile label="Denied" display={String(gov?.denied ?? 0)} accent={gov?.denied ? "var(--wp-error, #e5484d)" : undefined} testId="eff-denied" />
            <MetricTile label="Escalated to human" display={String(gov?.escalated ?? 0)} accent={gov?.escalated ? "var(--wp-warning, #f5a623)" : undefined} testId="eff-escalated" />
            <MetricTile label="Transformed" display={String(gov?.transformed ?? 0)} testId="eff-transformed" />
            <MetricTile label="Would block (monitor)" display={String(gov?.wouldBlock ?? 0)} accent={gov?.wouldBlock ? "var(--wp-warning, #f5a623)" : undefined} testId="eff-would-block" />
            <MetricTile label="Agents active" display={String(gov?.agentsActive ?? 0)} testId="eff-agents-active" />
          </div>

          <h3 style={{ margin: "1.75rem 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Cost</h3>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
            What the governed AI actually cost this month, read from the metered spend. Month-to-date, actual spend, no projection.
          </p>
          <div style={gridStyle} data-testid="eff-cost">
            <MetricTile label="AI spend, month to date" display={costDisplay} testId="eff-cost-mtd" />
          </div>

          <h3 style={{ margin: "1.75rem 0 0.25rem", fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Downstream enforcement</h3>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
            Agents actually stopped after the gate authorized them: the capability gate, connector-scope, the hourly ceiling, and the self-tamper gate.
          </p>
          <div style={gridStyle} data-testid="eff-enforcement">
            <MetricTile label="Capability denied" display={String(enf?.capabilityDenied ?? 0)} accent={enf?.capabilityDenied ? "var(--wp-error, #e5484d)" : undefined} testId="eff-cap-denied" />
            <MetricTile label="Connector-scope denied" display={String(enf?.connectorScopeDenied ?? 0)} accent={enf?.connectorScopeDenied ? "var(--wp-error, #e5484d)" : undefined} testId="eff-scope-denied" />
            <MetricTile label="Ceiling stops" display={String(enf?.ceilingHits ?? 0)} accent={enf?.ceilingHits ? "var(--wp-warning, #f5a623)" : undefined} testId="eff-ceiling-hits" />
            <MetricTile label="Self-tamper denied" display={String(enf?.conductDenied ?? 0)} accent={enf?.conductDenied ? "var(--wp-error, #e5484d)" : undefined} testId="eff-conduct-denied" />
          </div>

          <GlassPanel style={{ marginTop: "1.75rem" }}>
            <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--wp-text-dim, #b4bcc8)", lineHeight: 1.55 }}>
              These numbers are read from the platform&rsquo;s own tamper-evident records, not a separate report. &ldquo;Governed&rdquo; counts every change that ran the gate; &ldquo;blocked&rdquo; and &ldquo;contained&rdquo; count only what was actually stopped. No rate is shown over zero activity.
            </p>
          </GlassPanel>
        </>
      ) : null}
    </div>
  );
}
