"use client";

/**
 * useEmailArrivalPoll — silent (no UI) email arrival pinger.
 *
 * Replaces the polling that EmailNavBadge used to do before the badge
 * was hidden from the sidebar. Functionally identical: hits
 * /api/microsoft/messages/unread-count?since=<lastSeen> on an adaptive
 * cadence so the server can fan out `email_arrived` notifications to
 * the top-right NotificationBell whenever new mail arrives. Updates
 * `instinct.emails.last_seen` in localStorage so the next poll only
 * sees genuinely new messages.
 *
 * Returns nothing — this is a side-effect-only hook. Mount once at
 * the dashboard layout level.
 *
 * Same graceful-degradation contract as before: any failure path
 * silently resolves to count: 0 with no notification fan-out.
 */

import { useCallback, useEffect, useRef } from "react";
import { getInstinctToken } from "@/lib/client-auth";
import { coalescedFetchWithRefresh } from "@/lib/coalesced-fetch";
import { useAdaptivePoll } from "@/lib/hooks/useAdaptivePoll";

const LAST_SEEN_KEY = "instinct.emails.last_seen";

interface UnreadCountResponse {
  count?: number;
  connected?: boolean;
  scope_missing?: boolean;
}

function readLastSeen(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function useEmailArrivalPoll(): void {
  const silencedRef = useRef(false);
  const lastCountRef = useRef(0);
  const currentCountRef = useRef(0);

  const fetchCount = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!getInstinctToken()) return;
    if (silencedRef.current) return;
    const since = readLastSeen();
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    try {
      const res = await coalescedFetchWithRefresh(
        `/api/microsoft/messages/unread-count${qs}`,
      );
      if (!res.ok) {
        currentCountRef.current = 0;
        return;
      }
      const data = (await res.json()) as UnreadCountResponse;
      if (data.scope_missing || data.connected === false) {
        // Stop polling for this session — the user hasn't connected
        // Microsoft, or the scope was revoked. Re-checks happen on
        // refresh anyway, no need to keep hammering.
        silencedRef.current = true;
        currentCountRef.current = 0;
        return;
      }
      currentCountRef.current =
        typeof data.count === "number" ? data.count : 0;
    } catch {
      // Silent — never throw out of a polling hook.
      currentCountRef.current = 0;
    }
  }, []);

  useAdaptivePoll(fetchCount, {
    isStable: () => lastCountRef.current === currentCountRef.current,
  });

  useEffect(() => {
    lastCountRef.current = currentCountRef.current;
  });
}
