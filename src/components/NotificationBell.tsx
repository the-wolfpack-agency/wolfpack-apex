"use client";

/**
 * Header notification bell.
 *
 * - Polls /api/notifications/unread-count every 30s for the badge number.
 * - Click opens a dropdown with the 10 most recent unread notifications.
 * - Each row: title, body snippet, relative time.
 *   - Primary click → POST /api/notifications/[id]/click then nav to action_url.
 *   - X button → POST /api/notifications/[id]/dismiss.
 * - Footer "See all" → /notifications.
 *
 * No other header component owns this surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface BellNotification {
  id: string;
  category: string;
  priority: "low" | "normal" | "high" | "critical";
  title: string;
  body: string | null;
  action_url: string | null;
  action_label: string | null;
  created_at: string;
  read_at: string | null;
}

const POLL_INTERVAL_MS = 30_000;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function priorityColor(p: BellNotification["priority"]): string {
  switch (p) {
    case "critical":
      return "var(--wp-danger, #ef4444)";
    case "high":
      return "var(--wp-warning, #f59e0b)";
    case "low":
      return "var(--wp-text-muted, #6b7280)";
    default:
      return "var(--wp-info, #3b82f6)";
  }
}

export default function NotificationBell() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BellNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/notifications/unread-count", {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { count?: number };
      if (typeof data.count === "number") setCount(data.count);
    } catch {
      /* swallow — bell stays stale rather than failing */
    }
  }, []);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithRefresh("/api/notifications?read=unread&limit=10", {
        headers: authHeaders(),
      });
      if (!res.ok) {
        setItems([]);
        return;
      }
      const data = (await res.json()) as { notifications?: BellNotification[] };
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchCount]);

  useEffect(() => {
    if (open) fetchItems();
  }, [open, fetchItems]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function handleClick(n: BellNotification) {
    try {
      const res = await fetchWithRefresh(`/api/notifications/${n.id}/click`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = (await res.json().catch(() => ({}))) as { action_url?: string | null };
      const dest = data.action_url ?? n.action_url;
      // optimistic decrement
      setCount((c) => Math.max(0, c - 1));
      setItems((list) => list.filter((x) => x.id !== n.id));
      setOpen(false);
      if (dest) router.push(dest);
    } catch {
      /* leave bell state alone */
    }
  }

  async function handleDismiss(id: string, ev: React.MouseEvent) {
    ev.stopPropagation();
    try {
      await fetchWithRefresh(`/api/notifications/${id}/dismiss`, {
        method: "POST",
        headers: authHeaders(),
      });
      setCount((c) => Math.max(0, c - 1));
      setItems((list) => list.filter((x) => x.id !== id));
    } catch {
      /* ignore */
    }
  }

  async function handleMarkAllRead() {
    try {
      await fetchWithRefresh("/api/notifications/mark-all-read", {
        method: "POST",
        headers: authHeaders(),
      });
      setCount(0);
      setItems([]);
    } catch {
      /* ignore */
    }
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Notifications"
        data-testid="notification-bell"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg"
        style={{ color: "var(--wp-text-dim)" }}
      >
        <svg
          className="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {count > 0 && (
          <span
            data-testid="notification-bell-count"
            className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
            style={{
              background: "var(--wp-gold, #d4af37)",
              color: "var(--wp-dark, #0a0a0a)",
            }}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="notification-bell-dropdown"
          className="absolute right-0 mt-2 w-80 rounded-lg shadow-xl border overflow-hidden z-50"
          style={{
            background: "var(--wp-dark-surface, #111)",
            borderColor: "var(--wp-dark-border, #222)",
          }}
        >
          <div
            className="px-3 py-2 border-b flex items-center justify-between"
            style={{ borderColor: "var(--wp-dark-border, #222)" }}
          >
            <span className="text-sm font-semibold">Notifications</span>
            {items.length > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs"
                style={{ color: "var(--wp-text-muted, #888)" }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && (
              <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--wp-text-muted, #888)" }}>
                Loading...
              </div>
            )}
            {!loading && items.length === 0 && (
              <div
                data-testid="notification-bell-empty"
                className="px-3 py-6 text-xs text-center"
                style={{ color: "var(--wp-text-muted, #888)" }}
              >
                You&apos;re all caught up.
              </div>
            )}
            {!loading &&
              items.map((n) => (
                <div
                  key={n.id}
                  data-testid={`notification-item-${n.id}`}
                  className="px-3 py-2 border-b flex gap-2 items-start hover:bg-white/5"
                  style={{ borderColor: "var(--wp-dark-border, #222)" }}
                >
                  <button
                    type="button"
                    onClick={() => handleClick(n)}
                    className="flex-1 text-left flex gap-2 items-start min-w-0"
                  >
                    <span
                      aria-hidden
                      className="mt-1.5 w-2 h-2 rounded-full shrink-0"
                      style={{ background: priorityColor(n.priority) }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{n.title}</div>
                      {n.body && (
                        <div
                          className="text-xs mt-0.5 line-clamp-2"
                          style={{ color: "var(--wp-text-dim, #aaa)" }}
                        >
                          {n.body}
                        </div>
                      )}
                      <div
                        className="text-[10px] mt-1"
                        style={{ color: "var(--wp-text-muted, #888)" }}
                      >
                        {relativeTime(n.created_at)} • {n.category}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    data-testid={`notification-dismiss-${n.id}`}
                    onClick={(ev) => handleDismiss(n.id, ev)}
                    className="p-1 text-xs"
                    style={{ color: "var(--wp-text-muted, #888)" }}
                  >
                    &times;
                  </button>
                </div>
              ))}
          </div>

          <a
            href="/notifications"
            className="block px-3 py-2 text-center text-xs border-t"
            style={{
              borderColor: "var(--wp-dark-border, #222)",
              color: "var(--wp-gold, #d4af37)",
            }}
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              router.push("/notifications");
            }}
          >
            See all
          </a>
        </div>
      )}
    </div>
  );
}
