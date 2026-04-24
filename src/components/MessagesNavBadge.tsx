"use client";

/**
 * Sidebar badge for the "Messages" nav item — small visual cue so a
 * user sees an unread Teams message even if the top-nav
 * TeamsUnreadBadge falls outside their attention. Mirrors the
 * polling contract of TeamsUnreadBadge but renders a smaller,
 * non-clickable indicator (the nav item itself routes to /messages
 * — this is just the dot beside it).
 *
 * Hidden when count === 0 OR scope_missing OR connected:false. Same
 * graceful-degradation contract as TeamsUnreadBadge.
 */

import { useCallback, useRef, useState } from "react";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import { useAdaptivePoll } from "@/lib/hooks/useAdaptivePoll";

const LAST_SEEN_KEY = "instinct.messages.last_seen";

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

export default function MessagesNavBadge() {
  const [count, setCount] = useState(0);
  const silencedRef = useRef(false);

  const fetchCount = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!getInstinctToken()) return;
    const since = readLastSeen();
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    try {
      const res = await fetchWithRefresh(`/api/ms/chats/unread-count${qs}`);
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
      setCount(0);
    }
  }, []);

  // Adaptive polling: 5s when tab is visible, 45s when hidden. Same
  // battery profile as the old 45s baseline when the user is away,
  // ~9× faster perceived latency when they're at the screen.
  useAdaptivePoll(fetchCount);

  if (count <= 0 || silencedRef.current) return null;

  return (
    <span
      data-testid="messages-nav-badge"
      aria-label={`${count} unread Teams message${count === 1 ? "" : "s"}`}
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
