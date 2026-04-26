"use client";

/**
 * NewMessageToast — slide-in toast that fires when the Teams unread
 * count grows during this session. Mounted once in the dashboard
 * layout so it shows from any page.
 *
 * Design rationale:
 *
 *   - The page-title prefix ("(N) Instinct") and the gold pulsing
 *     badge in the top bar are good but not impossible-to-miss. A
 *     toast that slides in from the top-right of the viewport hits
 *     the "blaring obvious" bar without hijacking the user's keyboard
 *     focus or current task.
 *
 *   - We poll the same /api/ms/chats/unread-count?since=<last_seen>
 *     endpoint TeamsUnreadBadge polls — but DO NOT show a toast on
 *     mount, only when count GROWS. Otherwise reloading the page
 *     would re-show old messages every time.
 *
 *   - Auto-dismisses after 8s. Click-through writes last_seen +
 *     navigates to /messages (matching badge behavior). Manual ✕
 *     dismisses without writing last_seen so the badge keeps
 *     reminding.
 *
 *   - Hidden when the user is already on /messages — no point
 *     toasting about messages they're staring at.
 *
 *   - Same fetchWithRefresh / dark-theme / silenced-on-degraded
 *     contract as TeamsUnreadBadge.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import { useAdaptivePoll } from "@/lib/hooks/useAdaptivePoll";

const LAST_SEEN_KEY = "instinct.messages.last_seen";
const AUTO_DISMISS_MS = 8000;

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
    /* private mode / quota */
  }
}

export default function NewMessageToast() {
  const router = useRouter();
  const pathname = usePathname();
  const [delta, setDelta] = useState(0);
  const lastCountRef = useRef<number | null>(null);
  const dismissedAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCount = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!getInstinctToken()) return;
    /* Suppress on /messages — no point toasting about messages the
       user is staring at. */
    if (window.location.pathname === "/messages") return;

    const since = readLastSeen();
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    try {
      const res = await fetchWithRefresh(`/api/ms/chats/unread-count${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as UnreadCountResponse;
      if (data.scope_missing || data.connected === false) {
        lastCountRef.current = 0;
        return;
      }
      const next = typeof data.count === "number" ? data.count : 0;
      const prev = lastCountRef.current;
      lastCountRef.current = next;
      /* First poll establishes baseline — never toast on mount. */
      if (prev === null) return;
      if (next <= prev) return;
      /* Don't re-toast if the user just dismissed within the last 3s
         (prevents feedback loop with the auto-dismiss timer + a
         subsequent poll). */
      if (Date.now() - dismissedAtRef.current < 3000) return;

      setDelta(next - prev);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setDelta(0);
        timerRef.current = null;
      }, AUTO_DISMISS_MS);
    } catch {
      /* swallow */
    }
  }, []);

  useAdaptivePoll(fetchCount);

  /* Reset when navigating to /messages so the next visit starts
     fresh (the messages page itself updates last_seen). */
  useEffect(() => {
    if (pathname === "/messages" && delta > 0) {
      setDelta(0);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [pathname, delta]);

  function handleOpen(ev: React.MouseEvent<HTMLAnchorElement>) {
    ev.preventDefault();
    writeLastSeen(new Date().toISOString());
    setDelta(0);
    router.push("/messages");
  }

  function handleDismiss(ev: React.MouseEvent<HTMLButtonElement>) {
    ev.stopPropagation();
    dismissedAtRef.current = Date.now();
    setDelta(0);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  if (delta <= 0) return null;

  return (
    <>
      <style>{`
        @keyframes wp-msg-toast-in {
          from { transform: translateX(110%); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
      `}</style>
      <a
        href="/messages"
        role="alert"
        data-testid="new-message-toast"
        aria-label={`${delta} new Teams message${delta === 1 ? "" : "s"}`}
        onClick={handleOpen}
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 100,
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          background: "var(--wp-gold, #eab308)",
          color: "var(--wp-dark, #0a0a0a)",
          borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          textDecoration: "none",
          fontSize: 14,
          fontWeight: 600,
          maxWidth: 360,
          animation: "wp-msg-toast-in 220ms ease-out",
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
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
        <span style={{ flex: 1, lineHeight: 1.3 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>
            {delta === 1
              ? "New Teams message"
              : `${delta} new Teams messages`}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 12,
              opacity: 0.85,
              fontWeight: 500,
            }}
          >
            Tap to open
          </span>
        </span>
        <button
          type="button"
          data-testid="new-message-toast-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--wp-dark, #0a0a0a)",
            fontSize: 18,
            cursor: "pointer",
            padding: 0,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </a>
    </>
  );
}
