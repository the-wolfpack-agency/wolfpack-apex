"use client";

/**
 * AudienceBadge — small color-coded pill for ticket audience.
 *
 * client   — request from a paying client / dealer principal. Replies go
 *            from support@thewolfpack.agency. Blue/info color.
 * internal — request from a Wolfpack teammate. Replies go from the
 *            operator's personal address. Subtle gray.
 *
 * Mirrors the shape of SeverityBadge so the dashboard has one visual
 * vocabulary for "small categorical pill". Pairs nicely next to severity
 * + status pills in the ticket header and list rows.
 */

import type { CSSProperties } from "react";

export type Audience = "client" | "internal";

export const AUDIENCE_LABEL: Record<Audience, string> = {
  client: "Client",
  internal: "Internal",
};

export const AUDIENCE_DESCRIPTION: Record<Audience, string> = {
  client:
    "Client-facing request. Replies go from support@thewolfpack.agency.",
  internal:
    "Internal Wolfpack-team request. Replies go from your personal address.",
};

const STYLE: Record<Audience, { background: string; color: string }> = {
  /* `client` borrows the platform info-blue token so it visually
     reads as "this matters externally". */
  client: {
    background: "rgba(82,154,232,0.18)",
    color: "var(--wp-info, rgb(120,180,232))",
  },
  /* `internal` is intentionally low-contrast — operators should not
     mistake every internal ticket for a client emergency. */
  internal: {
    background: "rgba(160,168,180,0.18)",
    color: "var(--wp-text-dim)",
  },
};

export default function AudienceBadge({
  audience,
  style: extraStyle,
}: {
  audience: Audience;
  style?: CSSProperties;
}) {
  const s = STYLE[audience];
  const label = AUDIENCE_LABEL[audience];
  return (
    <span
      data-testid={`audience-badge-${audience}`}
      data-audience={audience}
      title={AUDIENCE_DESCRIPTION[audience]}
      aria-label={`Audience: ${label}`}
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
      {label}
    </span>
  );
}
