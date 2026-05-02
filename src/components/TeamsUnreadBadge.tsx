"use client";

/**
 * Cross-page Teams unread indicator for the top nav.
 *
 * Polls GET /api/ms/chats/unread-count?since=<last_seen> every
 * `POLL_INTERVAL_MS` (45s) and whenever the window regains focus. The
 * server returns `{ count, connected?, scope_missing?, total_chats }`;
 * we only render when `count > 0`. scope_missing + connected:false are
 * treated as silent hides so the badge never nags users who haven't
 * linked MS yet.
 *
 * Click flow:
 *   1. Fire `messages.unread_badge_clicked` analytics with the current
 *      count so the learning loop can see real engagement.
 *   2. Write `Date.now()` ISO string into localStorage under
 *      `instinct.messages.last_seen` so the next poll zeroes out.
 *   3. Navigate to /messages.
 *
 * Non-negotiables followed:
 *   - All fetches via `fetchWithRefresh` (no raw fetch to an
 *     authenticated route from a "use client" component).
 *   - Dark-theme CSS vars only; no hard-coded colors.
 *   - Graceful degradation: every non-ok response, throw, or
 *     degraded shape hides the badge silently.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import { coalescedFetchWithRefresh } from "@/lib/coalesced-fetch";
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

function writeLastSeen(iso: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_SEEN_KEY, iso);
  } catch {
    /* ignore — private mode / quota */
  }
}

/**
 * Fire-and-forget analytics helper. Never blocks, never throws.
 * Mirrors the shape used by messages/page.tsx.
 */
function fireAnalytics(
  event: "messages.unread_badge_clicked",
  metadata: Record<string, string | number | boolean>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, metadata }),
  }).catch(() => undefined);
}

export default function TeamsUnreadBadge() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  // Tracks scope_missing / connected:false so we keep the badge hidden
  // AND stop polling aggressively. The poll still runs, but a silent
  // hide is the whole contract per the ticket.
  const silencedRef = useRef(false);
  // Track previous count so we can detect *new* messages between polls
  // and fire a browser notification + title-bar tag. Without this we'd
  // notify on every poll where count > 0, including the initial mount.
  const lastCountRef = useRef(0);
  // Cache the original document.title so we can restore it when the
  // unread count drops to zero. Captured once on mount.
  const originalTitleRef = useRef<string>("");

  const fetchCount = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!getInstinctToken()) return;

    const since = readLastSeen();
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";

    try {
      const res = await coalescedFetchWithRefresh(
        `/api/ms/chats/unread-count${qs}`,
      );
      if (!res.ok) {
        // 401 will already have triggered the refresh/redirect flow
        // inside fetchWithRefresh. Any other non-200 hides the badge
        // to avoid flashing a broken state.
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
      const next = typeof data.count === "number" ? data.count : 0;
      setCount(next);
    } catch {
      // Network / parse error — stay stale rather than failing.
      setCount(0);
    }
  }, []);

  // React to count changes: fire a browser notification if the count
  // *grew* (new messages arrived since the last poll), and tag the
  // document.title so users with the tab in the background see "(N)
  // Instinct" — same affordance Gmail / Slack use. Only fires when the
  // user isn't already on /messages (no point notifying about a
  // message they're staring at).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!originalTitleRef.current) {
      originalTitleRef.current = document.title.replace(/^\(\d+\)\s*/, "");
    }
    const prev = lastCountRef.current;
    lastCountRef.current = count;

    // Title prefix.
    const base = originalTitleRef.current || "Instinct";
    document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;

    // Notification gate.
    if (count <= prev) return;
    if (window.location.pathname === "/messages") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") return;

    const fire = () => {
      try {
        const delta = count - prev;
        const n = new Notification(
          delta === 1 ? "New Teams message" : `${delta} new Teams messages`,
          {
            body: "Open Instinct to read and reply.",
            icon: "/wolfpack-logo.png",
            tag: "instinct-teams-unread",
            // Renotify on each new arrival rather than silently
            // collapsing into the previous notification.
            renotify: true,
          } as NotificationOptions,
        );
        n.onclick = () => {
          window.focus();
          router.push("/messages");
          n.close();
        };
      } catch {
        /* notification API failure is non-fatal */
      }
    };

    if (Notification.permission === "granted") {
      fire();
    } else if (Notification.permission === "default") {
      // Lazy permission ask — only when there's actually something to
      // notify about. No nagging on first page load with zero unread.
      void Notification.requestPermission().then((p) => {
        if (p === "granted") fire();
      });
    }
  }, [count, router]);

  // Adaptive polling: 5s when tab is visible, 45s when hidden.
  // Hook owns the visibility + focus listeners.
  // 30s visible / 120s hidden / 180s idle. Idle backoff engages once
  // the count has been stable for 5 polls; any change resets it.
  useAdaptivePoll(fetchCount, {
    isStable: () => lastCountRef.current === count,
  });

  function handleClick(ev: React.MouseEvent<HTMLAnchorElement>) {
    ev.preventDefault();
    const now = new Date().toISOString();
    fireAnalytics("messages.unread_badge_clicked", { count });
    writeLastSeen(now);
    setCount(0);
    router.push("/messages");
  }

  if (count <= 0 || silencedRef.current) return null;

  return (
    <>
      {/* Local @keyframes — kept inline so this component is fully
          self-contained (no global CSS file dependency). The pulse
          ring is gold-tinted and fades out so it draws the eye
          without becoming visual noise. */}
      <style>{`
        @keyframes wp-unread-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.55); }
          70%  { box-shadow: 0 0 0 10px rgba(234, 179, 8, 0); }
          100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0); }
        }
        .wp-unread-badge-pulse {
          animation: wp-unread-pulse 1.4s cubic-bezier(0.66, 0, 0, 1) infinite;
        }
      `}</style>
      <a
        href="/messages"
        data-testid="teams-unread-badge"
        aria-label={`Teams: ${count} new message${count === 1 ? "" : "s"}`}
        onClick={handleClick}
        className="wp-unread-badge-pulse relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-bold transition-colors"
        style={{
          color: "var(--wp-dark)",
          background: "var(--wp-gold)",
          border: "1px solid var(--wp-dark-border)",
        }}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
          />
        </svg>
        <span data-testid="teams-unread-badge-count">
          {count > 99 ? "99+" : count}
        </span>
      </a>
    </>
  );
}
