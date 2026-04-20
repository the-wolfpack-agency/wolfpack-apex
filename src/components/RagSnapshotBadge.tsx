"use client";

/**
 * RagSnapshotBadge — "From snapshot · 2h ago" pill for RAG callers
 * (Path C — Stream U5).
 *
 * Visual language:
 *   - Exact hit:  "From snapshot · 2h ago"
 *   - Fuzzy hit:  "Similar match · 73% · 2h ago"
 *   - Optional 🔄 refresh button (shown only when online AND an
 *     `onRefresh` callback was provided).
 *
 * No analytics are emitted from this component — `rag-offline.ts`
 * already owns the event surface. Stream U2 wires this wherever it
 * renders the cached RAG answer so the user knows they're seeing a
 * snapshot rather than a fresh retrieval.
 */

import React from "react";

export interface RagSnapshotBadgeProps {
  /** Cache write time (ms epoch) — typically `entry.cached_at`. */
  cachedAtMs: number;
  /** True when the hit came from Jaccard fuzzy match, not fingerprint. */
  isFuzzy: boolean;
  /** Jaccard score ∈ [0,1]; rendered as a percent on fuzzy hits. */
  similarity?: number;
  /** Optional manual refresh callback. Button is hidden when omitted. */
  onRefresh?: () => void;
  /**
   * Whether the client has network connectivity. Refresh button
   * renders ONLY when online AND `onRefresh` is supplied — hitting
   * refresh while offline would just fail.
   */
  isOnline?: boolean;
  /** Test-only: override "now" for deterministic age strings. */
  nowMs?: number;
}

function formatAge(ageMs: number): string {
  if (ageMs < 0) ageMs = 0;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RagSnapshotBadge(props: RagSnapshotBadgeProps): React.JSX.Element {
  const { cachedAtMs, isFuzzy, similarity, onRefresh, isOnline, nowMs } = props;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const ageMs = now - cachedAtMs;
  const ageLabel = formatAge(ageMs);

  const simPct =
    typeof similarity === "number" && Number.isFinite(similarity)
      ? Math.round(similarity * 100)
      : null;

  const label = isFuzzy
    ? simPct !== null
      ? `Similar match · ${simPct}% · ${ageLabel}`
      : `Similar match · ${ageLabel}`
    : `From snapshot · ${ageLabel}`;

  const ariaLabel = isFuzzy
    ? simPct !== null
      ? `Similar cached result (${simPct}% match), ${ageLabel}`
      : `Similar cached result, ${ageLabel}`
    : `Served from cached snapshot, ${ageLabel}`;

  const showRefresh = typeof onRefresh === "function" && isOnline === true;

  return (
    <span
      data-testid="rag-snapshot-badge"
      data-mode={isFuzzy ? "fuzzy" : "exact"}
      aria-label={ariaLabel}
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.375rem",
        padding: "0.125rem 0.5rem",
        borderRadius: "9999px",
        fontSize: "0.75rem",
        lineHeight: "1rem",
        background: isFuzzy ? "#FEF3C7" : "#E0E7FF",
        color: isFuzzy ? "#92400E" : "#3730A3",
        border: `1px solid ${isFuzzy ? "#FCD34D" : "#A5B4FC"}`,
      }}
    >
      <span data-testid="rag-snapshot-badge-label">{label}</span>
      {showRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh snapshot"
          data-testid="rag-snapshot-badge-refresh"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "0 0.125rem",
            fontSize: "0.75rem",
            lineHeight: "1rem",
            color: "inherit",
          }}
        >
          {"\u21BB"}
        </button>
      ) : null}
    </span>
  );
}

export default RagSnapshotBadge;
