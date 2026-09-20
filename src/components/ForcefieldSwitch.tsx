"use client";

/**
 * ForcefieldSwitch - the "Forcefield is ON" moment. A prominent, glowing hero
 * control that lets an operator turn real-time auto-blocking on or off, and makes
 * the protection state feel tangible. Mirrors OGIAM's enforcement posture:
 *
 *   MONITORING (default, shadow) - the edge decides + records the would-be action
 *                                  but never blocks. Safe default.
 *   PROTECTING (enforce)         - the edge blocks / challenges hostile agents in
 *                                  real time, before the page is served.
 *
 * Honest by construction: it says plainly that nothing is blocked until a human
 * turns it on. Styled in the same futuristic language as the agent-origin map
 * (dark panel, glow, a pulsing core) so protection reads at a glance. The pulse
 * respects prefers-reduced-motion.
 *
 * Reuses the edge-policy test ids so it IS the edge-policy control, just elevated.
 */
import type { EdgeMode } from "@/lib/forcefield/edge-enforcement";

export function ForcefieldSwitch({
  mode,
  canManage,
  onToggle,
  wouldActCount,
}: {
  mode: EdgeMode;
  canManage: boolean;
  onToggle: (next: EdgeMode) => void;
  /** How many operators in view the edge would block or challenge if enforcing. */
  wouldActCount: number;
}) {
  const on = mode === "enforce";
  const accent = on ? "#30a46c" : "#f5a623";

  return (
    <div
      data-testid="edge-policy"
      data-mode={mode}
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
        padding: "1rem 1.15rem",
        border: `1px solid ${on ? "rgba(48,164,108,0.6)" : "var(--wp-dark-border, #2a2f38)"}`,
        background: on
          ? "radial-gradient(120% 160% at 12% 0%, rgba(48,164,108,0.16) 0%, #0b0d11 62%)"
          : "radial-gradient(120% 160% at 12% 0%, rgba(245,166,35,0.08) 0%, #0b0d11 66%)",
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        flexWrap: "wrap",
      }}
    >
      <style>{`
        @keyframes ff-shield-pulse { 0%,100% { opacity: 0.85; transform: scale(1); } 50% { opacity: 0.35; transform: scale(1.35); } }
        .ff-shield-halo { animation: ff-shield-pulse 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .ff-shield-halo { animation: none; } }
      `}</style>

      {/* glowing core, like a map node */}
      <span aria-hidden style={{ position: "relative", width: 34, height: 34, flex: "0 0 auto" }}>
        <span className={on ? "ff-shield-halo" : undefined} style={{ position: "absolute", inset: 0, borderRadius: 999, background: accent, opacity: on ? 0.45 : 0.25 }} />
        <span style={{ position: "absolute", inset: 9, borderRadius: 999, background: accent, boxShadow: `0 0 12px ${accent}` }} />
      </span>

      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--wp-text-muted, #9ca3af)" }}>Forcefield</span>
          <span data-testid="edge-policy-mode" style={{ fontSize: "1.05rem", fontWeight: 800, letterSpacing: "0.02em", color: accent }}>
            {on ? "PROTECTING" : "MONITORING"}
          </span>
        </div>
        <div style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #b8bcc4)", marginTop: "0.15rem", lineHeight: 1.4 }}>
          {on ? (
            <>Hostile agents are <strong style={{ color: "var(--wp-text, #eee)" }}>blocked or challenged in real time</strong> at the edge, before your page is served.</>
          ) : (
            <>Watching and recording every decision. <strong style={{ color: "var(--wp-text, #eee)" }}>Nothing is blocked</strong> until you turn protection on.</>
          )}
        </div>
        <div data-testid="forcefield-standby-count" style={{ fontSize: "0.74rem", color: on ? "var(--wp-success, #30a46c)" : "var(--wp-warning, #f5a623)", marginTop: "0.3rem", fontWeight: 600 }}>
          {wouldActCount === 0
            ? on ? "No hostile agents in range right now - all clear." : "No hostile agents in range right now."
            : on
              ? `Guarding against ${wouldActCount} hostile agent${wouldActCount === 1 ? "" : "s"} in range.`
              : `${wouldActCount} hostile agent${wouldActCount === 1 ? "" : "s"} in range would be stopped the moment you turn this on.`}
        </div>
      </div>

      {/* the switch */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem", flex: "0 0 auto" }}>
        <button
          type="button"
          data-testid="edge-policy-toggle"
          role="switch"
          aria-checked={on}
          aria-label="Forcefield auto-block protection"
          disabled={!canManage}
          title={canManage ? "" : "You need manage permission to change protection."}
          onClick={() => canManage && onToggle(on ? "monitor" : "enforce")}
          style={{
            position: "relative",
            width: 76,
            height: 34,
            borderRadius: 999,
            border: `1px solid ${on ? accent : "var(--wp-dark-border, #3a3f48)"}`,
            background: on ? "rgba(48,164,108,0.28)" : "rgba(255,255,255,0.05)",
            cursor: canManage ? "pointer" : "not-allowed",
            opacity: canManage ? 1 : 0.55,
            transition: "background 160ms ease, border-color 160ms ease",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 3,
              left: on ? 45 : 3,
              width: 26,
              height: 26,
              borderRadius: 999,
              background: on ? accent : "var(--wp-text-muted, #9ca3af)",
              boxShadow: on ? `0 0 10px ${accent}` : "none",
              transition: "left 160ms ease, background 160ms ease",
            }}
          />
        </button>
        <span style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: on ? accent : "var(--wp-text-muted, #9ca3af)" }}>
          {on ? "On" : "Off"}
        </span>
      </div>
    </div>
  );
}

export default ForcefieldSwitch;
