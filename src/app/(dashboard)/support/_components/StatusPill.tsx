"use client";

/**
 * StatusPill — green / yellow / blue / dim badge showing where the
 * ticket sits in its lifecycle.
 *
 *   open      — submitted, no draft yet (yellow, "Needs you")
 *   drafted   — AI draft ready for review (gold, "Drafted")
 *   sent      — response sent to user (green, "Sent")
 *   resolved  — user confirmed it helped (green, "Resolved")
 *   closed    — closed without resolution (dim, "Closed")
 *
 * Colors reuse the same rgba tokens as SeverityBadge / porsche-classes
 * setup so all status surfaces in the dashboard read as one family.
 */

import type { CSSProperties } from "react";

export type TicketStatus =
  | "open"
  | "drafted"
  | "sent"
  | "resolved"
  | "closed";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  drafted: "Drafted",
  sent: "Sent",
  resolved: "Resolved",
  closed: "Closed",
};

const STYLE: Record<
  TicketStatus,
  { background: string; color: string; icon: string }
> = {
  open: {
    background: "rgba(229,180,69,0.18)",
    color: "rgb(229,180,69)",
    icon: "•",
  },
  drafted: {
    background: "rgba(229,180,69,0.18)",
    color: "rgb(229,180,69)",
    icon: "✎",
  },
  sent: {
    background: "rgba(80,175,110,0.18)",
    color: "rgb(120,210,150)",
    icon: "→",
  },
  resolved: {
    background: "rgba(80,175,110,0.18)",
    color: "rgb(120,210,150)",
    icon: "✓",
  },
  closed: {
    background: "rgba(160,168,180,0.18)",
    color: "var(--wp-text-dim)",
    icon: "·",
  },
};

export default function StatusPill({
  status,
  style: extraStyle,
}: {
  status: TicketStatus;
  style?: CSSProperties;
}) {
  const s = STYLE[status];
  return (
    <span
      data-testid={`status-pill-${status}`}
      data-status={status}
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.2rem 0.55rem",
        borderRadius: 999,
        fontSize: "0.78rem",
        fontWeight: 600,
        background: s.background,
        color: s.color,
        whiteSpace: "nowrap",
        ...extraStyle,
      }}
    >
      <span aria-hidden>{s.icon}</span>
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}
