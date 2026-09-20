"use client";

/**
 * Shared Forcefield visual language - the primitives that make the map, the
 * case file, the hero switch, and the intel panels read as ONE system: a glowing
 * severity node, the map's severity palette, and the dark-radial + faint-grid
 * panel chrome. Pure presentational, CSP-safe (the pulse keyframe lives in
 * globals.css as .ff-glow-node).
 */
import type { CSSProperties, ReactNode } from "react";

export type IntelSeverity = "critical" | "high" | "medium" | "low" | "hostile" | "notice" | "good" | "muted";

/** One palette, everywhere. Red = hostile, amber = notice, gold = medium,
 *  green = good, grey = muted - the same meaning as the agent-origin map. */
export const SEVERITY_COLOR: Record<IntelSeverity, string> = {
  critical: "#ef4444",
  hostile: "#ef4444",
  high: "#f5a623",
  notice: "#f5a623",
  medium: "#e8b528",
  low: "#9ca3af",
  muted: "#9ca3af",
  good: "#30a46c",
};

/** A glowing node: a soft halo + a bright core, like a map dot. Hostile pulses. */
export function GlowNode({ color, size = 12, pulse = false }: { color: string; size?: number; pulse?: boolean }) {
  return (
    <span aria-hidden className={`ff-glow-node${pulse ? " ff-glow-node--pulse" : ""}`} style={{ width: size, height: size }}>
      <span className="ff-glow-halo" style={{ background: color, opacity: pulse ? 0.5 : 0.28 }} />
      <span className="ff-glow-core" style={{ inset: size * 0.25, background: color, boxShadow: `0 0 6px ${color}` }} />
    </span>
  );
}

/** The dark-radial panel chrome shared with the map/case-file/hero. Pass an
 *  accent to tint the corner glow (e.g. red for the payload panel). */
export function IntelPanel({
  title,
  subtitle,
  accent = "#5a7bd0",
  testId,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  accent?: string;
  testId?: string;
  children: ReactNode;
}) {
  const bg = `radial-gradient(120% 150% at 12% 0%, ${hexA(accent, 0.1)} 0%, #0b0d11 66%)`;
  return (
    <div
      data-testid={testId}
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
        padding: "1rem 1.15rem",
        border: "1px solid var(--wp-dark-border, #262a33)",
        background: bg,
      }}
    >
      {/* faint grid backdrop, echoing the map graticule */}
      <div aria-hidden style={GRID_STYLE} />
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--wp-text, #e8ebf0)" }}>{title}</span>
        </div>
        {subtitle && <p style={{ margin: "0.4rem 0 0", fontSize: "0.75rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.5 }}>{subtitle}</p>}
        <div style={{ marginTop: "0.9rem" }}>{children}</div>
      </div>
    </div>
  );
}

const GRID_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  backgroundImage: "linear-gradient(rgba(120,150,200,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(120,150,200,0.05) 1px, transparent 1px)",
  backgroundSize: "48px 48px",
  pointerEvents: "none",
};

/** #rrggbb + alpha -> rgba(). Falls back to the hex if it can't parse. */
function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
