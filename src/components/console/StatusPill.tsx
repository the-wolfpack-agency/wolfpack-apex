/**
 * StatusPill — small severity/status badge. The one consistent severity
 * vocabulary across platform-scans, agents list, and agent detail.
 *
 * Maps the input string to a tone via `toneForStatus` (severity.ts) and tints
 * a pill with the matching --wp-* token: a translucent fill + a same-hue
 * border + the token-colored label, plus a tiny status dot. Never hard-codes
 * a color. Pure presentational.
 */

"use client";

import type { ReactNode } from "react";
import { TONE_VAR, toneForStatus, type SeverityTone } from "./severity";

export interface StatusPillProps {
  /** The status / severity string, e.g. "critical", "resolved", "running". */
  status: string;
  /** Override the displayed label (defaults to the status string itself). */
  label?: ReactNode;
  /** Force a tone instead of deriving it from `status`. */
  tone?: SeverityTone;
  /** Hide the leading status dot. */
  hideDot?: boolean;
  /** Visual size. */
  size?: "sm" | "md";
  className?: string;
  testId?: string;
}

/** Same-hue translucent fill behind the pill. We reuse the token via
 *  color-mix so we never introduce a second source of color. */
function fillFor(varExpr: string): string {
  return `color-mix(in srgb, ${varExpr} 14%, transparent)`;
}
function borderFor(varExpr: string): string {
  return `color-mix(in srgb, ${varExpr} 38%, transparent)`;
}

export function StatusPill({
  status,
  label,
  tone,
  hideDot = false,
  size = "sm",
  className,
  testId,
}: StatusPillProps) {
  const resolved: SeverityTone = tone ?? toneForStatus(status);
  const varExpr = TONE_VAR[resolved];
  const pad = size === "md" ? "3px 10px" : "2px 8px";
  const fontSize = size === "md" ? 12 : 11;

  return (
    <span
      data-testid={testId ?? "status-pill"}
      data-tone={resolved}
      data-status={status}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: pad,
        fontSize,
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        textTransform: "capitalize",
        color: varExpr,
        background: fillFor(varExpr),
        border: `1px solid ${borderFor(varExpr)}`,
        borderRadius: 999,
      }}
    >
      {!hideDot && (
        <span
          data-testid="status-pill-dot"
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: varExpr,
            boxShadow: `0 0 6px ${varExpr}`,
            flexShrink: 0,
          }}
        />
      )}
      {label ?? status}
    </span>
  );
}

export default StatusPill;
