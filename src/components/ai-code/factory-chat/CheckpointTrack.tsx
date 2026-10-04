"use client";
/**
 * The checkpoint track widget: a row of dots that turn neon-green as each real
 * pipeline checkpoint clears. Blocked = neon red, held = amber, not-yet = dim.
 * Presentational only - it renders whatever checkpoints it is given (derived from
 * the real pipeline response + CI; see checkpoints.ts). No simulated progress.
 */
import type { Checkpoint } from "./types";
import { NEON, neonGlow } from "./neon";

const COLOR: Record<Checkpoint["status"], string> = {
  clear: NEON.clear,
  blocked: NEON.blocked,
  held: NEON.held,
  pending: NEON.pending,
};

export default function CheckpointTrack({ checkpoints }: { checkpoints: readonly Checkpoint[] }): React.ReactElement | null {
  if (checkpoints.length === 0) return null;
  return (
    <div data-testid="checkpoint-track" style={{ display: "flex", flexDirection: "column", gap: "0.5rem", margin: "0.5rem 0" }}>
      {checkpoints.map((c) => {
        const color = COLOR[c.status];
        const lit = c.status !== "pending";
        return (
          <div key={c.id} data-testid="checkpoint" data-status={c.status} style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span
              aria-hidden
              style={{
                width: 10, height: 10, borderRadius: "50%", flex: "0 0 auto",
                background: lit ? color : "transparent",
                border: `1px solid ${color}`,
                boxShadow: lit ? neonGlow(color) : "none",
              }}
            />
            <span style={{ fontSize: "0.82rem", color: c.status === "pending" ? NEON.textDim : NEON.text, fontWeight: 500 }}>{c.label}</span>
            {c.status === "blocked" && <span style={{ fontSize: "0.68rem", color: NEON.blocked, textTransform: "uppercase", letterSpacing: "0.04em" }}>blocked</span>}
            {c.status === "held" && <span style={{ fontSize: "0.68rem", color: NEON.held, textTransform: "uppercase", letterSpacing: "0.04em" }}>held</span>}
            {c.detail && (c.status === "blocked" || c.status === "held") && (
              <span style={{ fontSize: "0.72rem", color: NEON.textDim }}>· {c.detail}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
