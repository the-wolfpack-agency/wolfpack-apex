"use client";

/**
 * DirectEditToggle — Path C Phase 4 · Stream U2.
 *
 * Tiny client component that flips the preview into "direct edit mode."
 * Mounted by the editor shell (stream U1) above the preview iframe; when
 * the toggle is ON, the parent appends `?mode=edit` to the iframe src,
 * which the preview page reads to decide whether to mount the
 * `DirectEditOverlay`. OFF, we strip the param so the iframe reloads as
 * a read-only preview (same mode clients see on a share link).
 *
 * Analytics (per CLAUDE.md — every user-facing surface feeds the loop):
 *   - direct_edit.enabled  on toggle ON
 *   - direct_edit.disabled on toggle OFF
 *
 * The toggle is deliberately uncontrolled w.r.t. the iframe — the caller
 * passes `enabled` and `onToggle`, and the caller owns whatever URL or
 * state flip is required to get `?mode=edit` to the preview. That keeps
 * this component framework-agnostic and easy to mount from both the
 * Next.js edit page and a Playwright/RTL harness.
 */

import { useCallback } from "react";
import { authHeaders, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

export interface DirectEditToggleProps {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** Optional analytics sink — defaults to POST /api/analytics. */
  onAnalyticsEvent?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
  siteId?: string;
}

function emitDefault(
  event: string,
  metadata: Record<string, string | number | boolean>,
): void {
  try {
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { ...authHeaders(), ...jsonHeaders() },
      body: JSON.stringify({ event, metadata }),
    }).catch(() => {});
  } catch {
    /* non-fatal */
  }
}

export function DirectEditToggle({
  enabled,
  onToggle,
  onAnalyticsEvent,
  siteId,
}: DirectEditToggleProps) {
  const emit = useCallback(
    (event: string, metadata: Record<string, string | number | boolean>) => {
      if (onAnalyticsEvent) onAnalyticsEvent(event, metadata);
      else emitDefault(event, metadata);
    },
    [onAnalyticsEvent],
  );

  const handleClick = () => {
    const next = !enabled;
    onToggle(next);
    const meta: Record<string, string | number | boolean> = {};
    if (siteId) meta.site_id = siteId;
    emit(
      next ? "direct_edit.enabled" : "direct_edit.disabled",
      meta,
    );
  };

  return (
    <button
      type="button"
      data-testid="direct-edit-toggle"
      aria-pressed={enabled}
      aria-label={
        enabled ? "Disable direct edit mode" : "Enable direct edit mode"
      }
      onClick={handleClick}
      style={{
        padding: "6px 12px",
        borderRadius: 6,
        border: "1px solid rgba(0,0,0,0.12)",
        background: enabled ? "#0f1115" : "white",
        color: enabled ? "white" : "#0f1115",
        fontSize: 13,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {enabled ? "Direct edit: on" : "Direct edit: off"}
    </button>
  );
}

export default DirectEditToggle;
