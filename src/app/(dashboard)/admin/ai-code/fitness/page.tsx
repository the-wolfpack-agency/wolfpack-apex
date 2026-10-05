"use client";

/**
 * Model Fitness - the client-facing face of the whole measure->route loop. Per
 * model, it shows what the code factory MEASURED from the gate's own grades (the
 * free ground-truth labels): usable-output rate, first-pass rate, value-per-dollar,
 * the EMPIRICALLY observed capability tier vs the model's DECLARED tier (punching
 * above/below its weight class), the dominant failure class, and drift.
 *
 * All scoring happens server-side in /api/admin/ai-code/fitness (the scorers pull
 * the model registry + providers, which must not enter the client bundle). This
 * page only fetches + renders the ready-made payload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { SectionHeader, ConsoleGrid, GlassPanel, MetricTile } from "@/components/console";

interface FitnessModel {
  model: string;
  n: number;
  readyRate: number;
  firstPassRate: number;
  value: number | null;
  observedTier: string;
  confident: boolean;
  declaredTier: string | null;
  verdict: string; // matches | below | above | unproven | unknown
  topFailure: string;
}
interface DriftFlag {
  model: string;
  priorReadyRate: number;
  recentReadyRate: number;
  drop: number;
  priorN: number;
  recentN: number;
}
interface FitnessPayload {
  overall: { readyRate: number; firstPassRate: number; escalationRate: number; models: number };
  models: FitnessModel[];
  drift: DriftFlag[];
}

const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;

const TIER_TOKEN: Record<string, string> = {
  large: "var(--wp-success, #22c55e)",
  mid: "var(--wp-gold, #e8b528)",
  small: "var(--wp-error, #ef4444)",
};
// below = performs worse than its declared class (risk); above = punches up.
const VERDICT_TOKEN: Record<string, string> = {
  below: "var(--wp-error, #ef4444)",
  above: "var(--wp-success, #22c55e)",
  matches: "var(--wp-text-dim, #9aa4b2)",
  unproven: "var(--wp-text-dim, #9aa4b2)",
  unknown: "var(--wp-text-dim, #9aa4b2)",
};

export default function ModelFitnessPage() {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<FitnessPayload | null>(null);
  const viewedRef = useRef(false);

  const track = useCallback((event: string, metadata: Record<string, unknown>) => {
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event, metadata }),
    }).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const res = await fetchWithRefresh("/api/admin/ai-code/fitness");
    if (!res.ok) return; // a 401 already triggers refresh+redirect inside fetchWithRefresh
    const payload = (await res.json()) as FitnessPayload;
    setData(payload);
    if (!viewedRef.current) {
      viewedRef.current = true;
      track("ai_code.model_fitness_viewed", { models: payload.overall?.models ?? 0 });
    }
  }, [track]);

  useEffect(() => {
    if (!getInstinctUser()) { window.location.href = "/login?next=/admin/ai-code/fitness"; return; }
    setReady(true);
    void load();
  }, [load]);

  if (!ready) return null;

  const models = data?.models ?? [];
  const drift = data?.drift ?? [];
  const cell: React.CSSProperties = { padding: "8px 12px", borderBottom: "1px solid var(--wp-border, #2a2f3a)", textAlign: "left", fontVariantNumeric: "tabular-nums" };
  const head: React.CSSProperties = { ...cell, color: "var(--wp-text-dim, #9aa4b2)", fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" };

  return (
    <div data-testid="model-fitness-page" style={{ display: "flex", flexDirection: "column", gap: 20, padding: 24 }}>
      <SectionHeader
        eyebrow="Secure Agent"
        title="Model Fitness"
        subtitle="What the code factory measured about each model - from the gate's own grades. Measured capability, not vendor claims."
      />

      <ConsoleGrid minColWidth={200} testId="mf-metrics">
        <MetricTile label="Models measured" value={data?.overall.models ?? 0} testId="mf-models" />
        <MetricTile label="Ready rate" display={pct(data?.overall.readyRate)} testId="mf-ready" />
        <MetricTile label="First-pass" display={pct(data?.overall.firstPassRate)} testId="mf-firstpass" />
        <MetricTile label="Escalation" display={pct(data?.overall.escalationRate)} testId="mf-escalation" />
      </ConsoleGrid>

      <GlassPanel
        title="Model leaderboard"
        subtitle="Ranked by usable output, then first-pass, then cost. Value = ready output per dollar. Tier compares the model's OBSERVED capability to its DECLARED one."
        testId="model-leaderboard"
      >
        {models.length === 0 ? (
          <div data-testid="model-fitness-empty" style={{ color: "var(--wp-text-dim, #9aa4b2)", padding: "8px 4px" }}>
            No factory runs measured yet. Run the factory (or the dogfood harness) to build a model&apos;s fitness profile.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={head}>Model</th>
                  <th style={head}>Runs</th>
                  <th style={head}>Ready</th>
                  <th style={head}>First-pass</th>
                  <th style={head}>Value/$</th>
                  <th style={head}>Observed vs declared</th>
                  <th style={head}>Top failure</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model} data-testid={`mf-row-${m.model}`}>
                    <td style={{ ...cell, fontWeight: 600 }}>{m.model}</td>
                    <td style={cell}>{m.n}</td>
                    <td style={cell}>{pct(m.readyRate)}</td>
                    <td style={cell}>{pct(m.firstPassRate)}</td>
                    <td style={cell}>{m.value === null ? "—" : m.value.toFixed(1)}</td>
                    <td style={cell}>
                      <span style={{ color: TIER_TOKEN[m.observedTier] ?? "var(--wp-text-dim)", fontWeight: 600 }}>
                        {m.observedTier}{m.confident ? "" : " ?"}
                      </span>
                      {m.declaredTier ? (
                        <span style={{ color: "var(--wp-text-dim, #9aa4b2)" }}> / {m.declaredTier} </span>
                      ) : null}
                      {m.verdict === "below" || m.verdict === "above" ? (
                        <span style={{ color: VERDICT_TOKEN[m.verdict], fontWeight: 600 }}>({m.verdict})</span>
                      ) : null}
                    </td>
                    <td style={{ ...cell, color: m.topFailure === "clean" ? "var(--wp-success, #22c55e)" : "var(--wp-text, #e6e9ef)" }}>
                      {m.topFailure}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassPanel>

      <GlassPanel
        title="Drift"
        subtitle="Models whose ready-rate dropped materially in the recent window vs the prior one."
        testId="model-drift"
      >
        {drift.length === 0 ? (
          <div data-testid="mf-drift-empty" style={{ color: "var(--wp-text-dim, #9aa4b2)", padding: "8px 4px" }}>
            No drift detected.
          </div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {drift.map((d) => (
              <li key={d.model} data-testid={`mf-drift-${d.model}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                <strong>{d.model}</strong>: {pct(d.priorReadyRate)} → <span style={{ color: "var(--wp-error, #ef4444)" }}>{pct(d.recentReadyRate)}</span>
                {" "}(drop {pct(d.drop)}, n {d.priorN}→{d.recentN})
              </li>
            ))}
          </ul>
        )}
      </GlassPanel>
    </div>
  );
}
