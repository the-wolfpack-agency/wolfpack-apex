"use client";

/**
 * Sidebar badge for the "Emails" nav item — small visual cue so a
 * user sees inbound mail even when /emails isn't open. Mirrors the
 * polling contract of MessagesNavBadge but talks to the Microsoft
 * Graph mail surface.
 *
 * Hidden when count === 0 OR scope_missing OR connected:false. Same
 * graceful-degradation contract as MessagesNavBadge — the badge is
 * never a blocker, so any failure path quietly resolves to 0.
 *
 * Reads/writes a "last seen" timestamp under
 * `instinct.emails.last_seen` so the server can fan-out
 * email_arrived notifications to the top-right bell only for emails
 * that arrived since the user last visited /emails. Updated by
 * /emails on mount via window.dispatchEvent("instinct:emails-seen").
 */

import { useCallback, useEffect, useRef, useState } from "react";
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

export default function EmailNavBadge() {
  const [count, setCount] = useState(0);
  const silencedRef = useRef(false);

  const fetchCount = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!getInstinctToken()) return;
    const since = readLastSeen();
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    try {
      const res = await coalescedFetchWithRefresh(
        `/api/microsoft/messages/unread-count${qs}`,
      );
      if (!res.ok) {
        setCount(0);
        return;
      }
      const data = (await res.json()) as UnreadCountResponse;
      if (data.scope_missing || data.connected === false) {
        silencedRef.current = true;
        setCount(0);
        return;
      }
      silencedRef.current = false;
      setCount(typeof data.count === "number" ? data.count : 0);
    } catch {
      // Never throw — leave the badge stale rather than fail the UI.
      setCount(0);
    }
  }, []);

  // Adaptive polling: 30s visible, 120s hidden, 180s after the count
  // has been stable for 5 polls. Idle backoff downshifts to ~2 reqs/min
  // when no new mail arrives. Refocus / visibility change resets the
  // cadence and fires fresh.
  const lastCountRef = useRef(0);
  useAdaptivePoll(fetchCount, {
    isStable: () => lastCountRef.current === count,
  });
  useEffect(() => {
    lastCountRef.current = count;
  }, [count]);

  // Listen for an explicit "user just visited /emails" event so the
  // badge clears the moment the inbox is opened, even before the
  // next adaptive-poll tick. /emails dispatches this on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onSeen() {
      try {
        localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
      } catch {
        /* localStorage may be unavailable in private mode */
      }
      setCount(0);
    }
    window.addEventListener("instinct:emails-seen", onSeen);
    return () => window.removeEventListener("instinct:emails-seen", onSeen);
  }, []);

  if (count <= 0 || silencedRef.current) return null;

  return (
    <span
      data-testid="email-nav-badge"
      aria-label={`${count} unread email${count === 1 ? "" : "s"}`}
      className="ml-auto inline-flex items-center justify-center text-[10px] font-bold rounded-full"
      style={{
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        background: "var(--wp-gold, #eab308)",
        color: "var(--wp-dark, #111)",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
