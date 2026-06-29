"use client";

/**
 * ReleaseGateBanner - a compact, non-intrusive banner for the MAIN dashboard
 * that surfaces the production release gate where an operator/CLIENT actually
 * looks. The full review + promote surface lives at /admin/deployment; this
 * banner is the "you have built code waiting to ship" nudge that makes a
 * blocked production deploy impossible to miss from the landing page.
 *
 * Contract it consumes (server-only lib + route already exist):
 *   GET /api/admin/deployment/release-gate -> { ok, gate: ReleaseGateStatus }
 *
 * Behaviour:
 *   - blocking.length > 0  -> "N change(s) built and waiting to deploy to
 *     production. [most-urgent PR title] needs [its reason] -> View"
 *   - blocking empty       -> renders nothing (no noise when prod is current)
 *   - degraded             -> "Deploy status unknown - check release gate"
 *     (NEVER a false all-clear: honest-degrade is a non-negotiable of the gate)
 *
 * Auth + analytics:
 *   - Fetches via fetchWithRefresh ONLY (15-min access TTL, HttpOnly refresh).
 *   - Fires deploy.release_gate_viewed (existing InstinctEventType) on
 *     click-through, via the /api/analytics POST every client surface uses.
 */

import { useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type { ReleaseGateStatus, BlockingChange } from "@/lib/deploy/release-gate";

/**
 * Pick the most-urgent blocking change to headline the banner. Ordering mirrors
 * the lib's worst-to-ready intent: a conflict / failing build is more urgent
 * than something merely waiting on a review or already ready to ship.
 */
const STATE_URGENCY: Record<BlockingChange["state"], number> = {
  merge_conflict: 0,
  checks_failing: 1,
  checks_running: 2,
  awaiting_approval: 3,
  ready_to_merge: 4,
};

export function mostUrgent(blocking: BlockingChange[]): BlockingChange | null {
  if (blocking.length === 0) return null;
  return [...blocking].sort((a, b) => {
    const u = STATE_URGENCY[a.state] - STATE_URGENCY[b.state];
    if (u !== 0) return u;
    // Tie-break on age: the one blocking longest is the more urgent.
    return b.ageHours - a.ageHours;
  })[0];
}

export default function ReleaseGateBanner() {
  const [gate, setGate] = useState<ReleaseGateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithRefresh("/api/admin/deployment/release-gate");
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; gate: ReleaseGateStatus };
        if (!cancelled) setGate(data.gate);
      } catch {
        // Best-effort: a failed banner fetch must never break the dashboard.
        // The /admin/deployment surface is the authoritative read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleClickThrough() {
    // Fire-and-forget; navigation must not block on analytics.
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "deploy.release_gate_viewed",
        metadata: {
          source: "dashboard_banner",
          blocking_count: gate?.blocking.length ?? 0,
          degraded: !!gate?.degraded,
        },
      }),
    }).catch(() => {});
  }

  if (!gate) return null;

  // Honest degrade: we could not check, so we say so - never imply all-clear.
  if (gate.degraded) {
    return (
      <a
        href="/admin/deployment"
        data-testid="release-gate-banner-degraded"
        onClick={handleClickThrough}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          padding: "0.7rem 1rem",
          borderRadius: "0.6rem",
          textDecoration: "none",
          fontSize: "0.88rem",
          fontWeight: 600,
          color: "var(--wp-warning, #f97316)",
          background: "color-mix(in srgb, var(--wp-warning, #f97316) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--wp-warning, #f97316) 38%, transparent)",
        }}
      >
        Deploy status unknown - check release gate
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--wp-warning, #f97316)" }}>View →</span>
      </a>
    );
  }

  const blocking = gate.blocking;
  // Nothing blocking: render nothing. No noise when prod is current.
  if (blocking.length === 0) return null;

  const urgent = mostUrgent(blocking);
  const count = blocking.length;

  return (
    <a
      href="/admin/deployment"
      data-testid="release-gate-banner"
      data-count={count}
      onClick={handleClickThrough}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        flexWrap: "wrap",
        padding: "0.7rem 1rem",
        borderRadius: "0.6rem",
        textDecoration: "none",
        fontSize: "0.88rem",
        color: "var(--wp-text, #e9edf4)",
        background: "color-mix(in srgb, var(--wp-gold, #e8b528) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--wp-gold, #e8b528) 38%, transparent)",
      }}
    >
      <span style={{ fontWeight: 700, color: "var(--wp-gold, #e8b528)" }}>
        {count} change{count === 1 ? "" : "s"} built and waiting to deploy to production.
      </span>
      {urgent && (
        <span data-testid="release-gate-banner-urgent" style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>
          {urgent.title} needs {urgent.reason.toLowerCase()}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ fontWeight: 600, color: "var(--wp-gold, #e8b528)" }}>View →</span>
    </a>
  );
}
