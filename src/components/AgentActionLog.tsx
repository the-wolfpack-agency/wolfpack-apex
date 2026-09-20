"use client";

/**
 * AgentActionLog - the case file, styled to match the agent-origin map so the
 * product speaks one visual language: a dark panel, a faint grid, and glowing
 * nodes sized/colored by severity that pulse when hostile. Reads top-to-bottom
 * like a police report - lead-up, the hostile action, aftermath - each step a
 * timestamp, a plain sentence, and a node on the spine. The impressive full path
 * is the hero; the plain language makes it digestible for a non-technical reader.
 *
 * Pure presentational, theme-aware via --wp-* tokens, CSP-safe (inline CSS only).
 * Hostile nodes pulse unless the viewer prefers reduced motion. Renders nothing
 * when there are no steps (older data degrades gracefully).
 */
import { buildActionLog, PHASE_LABEL, type ActionSeverity } from "@/lib/agent-action-log";
import type { JourneyStep } from "@/lib/agent-behavior";

const SEV_COLOR: Record<ActionSeverity, string> = {
  good: "#30a46c",
  info: "#9ca3af",
  notice: "#f5a623",
  hostile: "#ef4444",
};

export function AgentActionLog({ steps, testId = "agent-case-file" }: { steps: readonly JourneyStep[]; testId?: string }) {
  const entries = buildActionLog(steps);
  if (entries.length === 0) return null;
  const hasHostile = entries.some((e) => e.phase === "hostile_act");

  return (
    <div
      data-testid={testId}
      style={{
        position: "relative",
        borderRadius: 10,
        padding: "0.9rem 1rem 0.9rem 0.75rem",
        background: "radial-gradient(120% 120% at 20% 0%, #0e1626 0%, #0b0d11 72%)",
        border: "1px solid var(--wp-dark-border, #262a33)",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes ff-cf-pulse { 0%,100% { opacity: 0.9; transform: scale(1); } 50% { opacity: 0.35; transform: scale(1.5); } }
        .ff-cf-halo { animation: ff-cf-pulse 2.2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .ff-cf-halo { animation: none; } }
      `}</style>

      {/* faint grid backdrop, echoing the map graticule */}
      <div aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(120,150,200,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(120,150,200,0.05) 1px, transparent 1px)", backgroundSize: "48px 48px", pointerEvents: "none" }} />

      <ol style={{ position: "relative", listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.15rem" }}>
        {entries.map((e, i) => {
          const color = SEV_COLOR[e.severity];
          const showPhase = i === 0 || e.phase !== entries[i - 1].phase;
          const phaseLabel = e.phase === "lead_up" && !hasHostile ? "Activity" : PHASE_LABEL[e.phase];
          const isHostile = e.severity === "hostile";
          return (
            <li key={i} style={{ position: "relative" }}>
              {showPhase && (
                <div
                  data-testid={`${testId}-phase-${e.phase}`}
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: i === 0 ? "0 0 0.5rem" : "0.7rem 0 0.5rem", paddingLeft: "2.1rem" }}
                >
                  <span style={{ fontSize: "0.58rem", fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: e.phase === "hostile_act" ? "var(--wp-error, #ef4444)" : "var(--wp-text-muted, #9ca3af)" }}>{phaseLabel}</span>
                  <span style={{ flex: 1, height: 1, background: e.phase === "hostile_act" ? "linear-gradient(90deg, rgba(239,68,68,0.5), transparent)" : "linear-gradient(90deg, rgba(120,150,200,0.25), transparent)" }} />
                </div>
              )}
              <div data-testid={`${testId}-entry-${i}`} style={{ display: "grid", gridTemplateColumns: "3.1rem 1.1rem 1fr", alignItems: "start", gap: "0.5rem", padding: "0.28rem 0" }}>
                {/* clock + delta */}
                <div style={{ textAlign: "right", lineHeight: 1.15, paddingTop: "0.05rem" }}>
                  <div style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontSize: "0.66rem", color: "var(--wp-text, #d8dbe0)", fontVariantNumeric: "tabular-nums" }}>{e.clock}</div>
                  <div style={{ fontSize: "0.56rem", color: "var(--wp-text-muted, #6b7280)", fontVariantNumeric: "tabular-nums" }}>{e.delta}</div>
                </div>
                {/* glowing node on the spine */}
                <div style={{ position: "relative", display: "flex", justifyContent: "center", alignSelf: "stretch" }}>
                  {i < entries.length - 1 && <span aria-hidden style={{ position: "absolute", top: "0.55rem", bottom: "-0.35rem", width: 2, background: "rgba(120,150,200,0.18)" }} />}
                  <span aria-hidden style={{ position: "relative", width: 12, height: 12, marginTop: "0.15rem" }}>
                    <span className={isHostile ? "ff-cf-halo" : undefined} style={{ position: "absolute", inset: 0, borderRadius: 999, background: color, opacity: isHostile ? 0.5 : 0.28 }} />
                    <span style={{ position: "absolute", inset: 3, borderRadius: 999, background: color, boxShadow: `0 0 6px ${color}` }} />
                  </span>
                </div>
                {/* headline + plain sentence */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem", flexWrap: "wrap" }}>
                    <span data-testid={`${testId}-headline-${i}`} style={{ fontSize: "0.78rem", fontWeight: 700, color }}>{e.headline}</span>
                    <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontSize: "0.66rem", color: "var(--wp-text-muted, #8b90a0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{e.path}</span>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "var(--wp-text-muted, #b8bcc4)", lineHeight: 1.4 }}>{e.detail}</div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default AgentActionLog;
