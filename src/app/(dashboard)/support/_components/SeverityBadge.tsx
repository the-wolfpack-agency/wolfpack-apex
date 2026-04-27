"use client";

/**
 * SeverityBadge — small color-coded pill for ticket severity.
 *
 * P0 (red)    — production down / urgent
 * P1 (orange) — broken for one or more users
 * P2 (yellow) — workaround exists, fix soon
 * P3 (dim)    — nice-to-have / question
 *
 * Color tokens mirror the porsche-classes status pills so the dashboard
 * has a single visual language for "good / warn / problem" everywhere.
 */

import type { CSSProperties } from "react";

export type Severity = "p0" | "p1" | "p2" | "p3";

export const SEVERITY_LABEL: Record<Severity, string> = {
  p0: "P0 · Urgent",
  p1: "P1 · High",
  p2: "P2 · Normal",
  p3: "P3 · Low",
};

export const SEVERITY_DESCRIPTION: Record<Severity, string> = {
  p0: "Production is down or a user is fully blocked",
  p1: "Broken for one or more users, needs same-day attention",
  p2: "Workaround exists, fix in normal cadence",
  p3: "Nice to have or a general question",
};

const STYLE: Record<Severity, { background: string; color: string }> = {
  p0: {
    background: "rgba(232,123,123,0.18)",
    color: "rgb(232,123,123)",
  },
  p1: {
    background: "rgba(229,180,69,0.18)",
    color: "rgb(229,180,69)",
  },
  p2: {
    background: "rgba(80,175,110,0.18)",
    color: "rgb(120,210,150)",
  },
  p3: {
    background: "rgba(160,168,180,0.18)",
    color: "var(--wp-text-dim)",
  },
};

export default function SeverityBadge({
  severity,
  style: extraStyle,
}: {
  severity: Severity;
  style?: CSSProperties;
}) {
  const s = STYLE[severity];
  return (
    <span
      data-testid={`severity-badge-${severity}`}
      data-severity={severity}
      title={SEVERITY_DESCRIPTION[severity]}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0.18rem 0.55rem",
        borderRadius: 999,
        fontSize: "0.75rem",
        fontWeight: 600,
        background: s.background,
        color: s.color,
        whiteSpace: "nowrap",
        ...extraStyle,
      }}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}
