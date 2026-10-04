"use client";
/**
 * Factory Brain: one glance at whether the factory is improving over time. Renders
 * the headline learning signals (memory corpora, first-pass trend, gate precision,
 * repair resolve rate, model grades, human-edit rate) from /brain-summary. Each
 * tile degrades to "n/a" until that signal has data, so it is honest on a cold
 * start rather than showing a fake 100%.
 */
import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel } from "@/components/console";

interface BrainSummary {
  windowDays: number;
  memory: { reuse: number; failures: number; exemplars: number };
  improving: { firstPassReadyRate: number | null; acceptanceRate: number | null; trend: string; runs: number };
  precision: { wrongRate: number | null; reviewed: number };
  repair: { resolveRate: number | null; runs: number };
  grades: { cells: number };
  corrections: { editRate: number | null; merged: number };
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const trendGlyph = (t: string): string => (t === "up" ? "↑" : t === "down" ? "↓" : t === "flat" ? "→" : "");

export default function FactoryBrainPanel(): React.ReactElement | null {
  const [s, setS] = useState<BrainSummary | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/admin/ai-code/brain-summary");
        if (!res.ok) return;
        const data = (await res.json()) as { summary?: BrainSummary };
        if (live && data.summary) setS(data.summary);
      } catch { /* best-effort readout */ }
    })();
    return () => { live = false; };
  }, []);

  if (!s) return null;

  const tiles: { k: string; v: string; sub: string; good?: "high" | "low"; trend?: string }[] = [
    { k: "Reuse corpus", v: s.memory.reuse.toLocaleString(), sub: "patterns to reuse" },
    { k: "Failure memory", v: s.memory.failures.toLocaleString(), sub: "mistakes not to repeat" },
    { k: "Exemplars", v: s.memory.exemplars.toLocaleString(), sub: "shipped & merged" },
    { k: "First-pass ready", v: pct(s.improving.firstPassReadyRate), sub: `${s.improving.runs} runs`, good: "high", trend: s.improving.trend },
    { k: "Acceptance", v: pct(s.improving.acceptanceRate), sub: "PRs merged", good: "high" },
    { k: "Gate false-positive", v: pct(s.precision.wrongRate), sub: `${s.precision.reviewed} labeled`, good: "low" },
    { k: "Auto-fix resolve", v: pct(s.repair.resolveRate), sub: `${s.repair.runs} blocks`, good: "high" },
    { k: "Needed human edit", v: pct(s.corrections.editRate), sub: `${s.corrections.merged} merged`, good: "low" },
  ];

  return (
    <GlassPanel
      title="Factory brain"
      subtitle={`Is the factory improving? The learning signals over the last ${s.windowDays} days. Tiles read "n/a" until a signal has data (honest cold start).`}
    >
      <div
        data-testid="factory-brain-panel"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem" }}
      >
        {tiles.map((t) => (
          <div
            key={t.k}
            data-testid="brain-tile"
            style={{ background: "var(--wp-surface-2, #171a21)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 8, padding: "0.6rem 0.75rem" }}
          >
            <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-dim)" }}>{t.k}</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: "0.2rem", color: "var(--wp-text, #e6e9ef)", fontVariantNumeric: "tabular-nums" }}>
              {t.v}
              {t.trend && trendGlyph(t.trend) && (
                <span
                  data-testid="brain-trend"
                  title={`first-pass trend: ${t.trend}`}
                  style={{ fontSize: "0.9rem", marginLeft: "0.4rem", color: t.trend === "up" ? "var(--wp-success, #22c55e)" : t.trend === "down" ? "var(--wp-error, #ef4444)" : "var(--wp-text-dim)" }}
                >
                  {trendGlyph(t.trend)}
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)", marginTop: "0.15rem" }}>{t.sub}</div>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}
