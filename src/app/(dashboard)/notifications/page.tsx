"use client";

/**
 * Notifications inbox.
 *
 * Tabs: Unread | All | By category | By priority
 * Search input (title/body ILIKE).
 * Cursor-paginated.
 * Bulk: Mark all read / Dismiss read.
 * Preferences panel toggle on the same page.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authHeaders, jsonHeaders } from "@/lib/client-auth";

interface Notification {
  id: string;
  category: string;
  priority: "low" | "normal" | "high" | "critical";
  title: string;
  body: string | null;
  action_url: string | null;
  created_at: string;
  read_at: string | null;
}

interface Preferences {
  in_app: boolean;
  email_digest: "off" | "realtime" | "daily" | "weekly";
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
  category_overrides: Record<string, "off" | "realtime" | "daily" | "weekly">;
}

type TabKey = "unread" | "all" | "category" | "priority";

const DIGEST_OPTIONS: Preferences["email_digest"][] = [
  "off",
  "realtime",
  "daily",
  "weekly",
];

export default function NotificationsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("unread");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<Preferences | null>(null);

  const load = useCallback(
    async (append = false) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (tab === "unread") params.set("read", "unread");
        else if (tab === "all") params.set("read", "all");
        if (tab === "category" && categoryFilter) {
          params.set("category", categoryFilter);
        }
        if (tab === "priority" && priorityFilter) {
          params.set("priority", priorityFilter);
        }
        if (search) params.set("search", search);
        if (append && cursor) params.set("cursor", cursor);
        const res = await fetch(`/api/notifications?${params.toString()}`, {
          headers: authHeaders(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          notifications?: Notification[];
          nextCursor?: string;
        };
        setItems(
          append
            ? [...items, ...(data.notifications ?? [])]
            : data.notifications ?? [],
        );
        setNextCursor(data.nextCursor);
      } finally {
        setLoading(false);
      }
    },
    [tab, categoryFilter, priorityFilter, search, cursor, items],
  );

  useEffect(() => {
    setCursor(undefined);
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, categoryFilter, priorityFilter]);

  const loadPrefs = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/preferences", {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { preferences?: Preferences };
      if (data.preferences) setPrefs(data.preferences);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (prefsOpen) loadPrefs();
  }, [prefsOpen, loadPrefs]);

  async function handleClickItem(n: Notification) {
    try {
      const res = await fetch(`/api/notifications/${n.id}/click`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = (await res.json().catch(() => ({}))) as { action_url?: string | null };
      const dest = data.action_url ?? n.action_url;
      if (dest) router.push(dest);
      else load(false);
    } catch {
      /* ignore */
    }
  }

  async function handleDismiss(id: string) {
    await fetch(`/api/notifications/${id}/dismiss`, {
      method: "POST",
      headers: authHeaders(),
    });
    setItems((arr) => arr.filter((x) => x.id !== id));
  }

  async function markAll() {
    await fetch("/api/notifications/mark-all-read", {
      method: "POST",
      headers: authHeaders(),
    });
    load(false);
  }

  async function dismissRead() {
    const readItems = items.filter((x) => x.read_at);
    for (const it of readItems) {
      await fetch(`/api/notifications/${it.id}/dismiss`, {
        method: "POST",
        headers: authHeaders(),
      });
    }
    setItems((arr) => arr.filter((x) => !x.read_at));
  }

  async function savePrefs(next: Preferences) {
    const res = await fetch("/api/notifications/preferences", {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify(next),
    });
    if (res.ok) {
      const data = (await res.json()) as { preferences?: Preferences };
      if (data.preferences) setPrefs(data.preferences);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <button
          type="button"
          onClick={() => setPrefsOpen((v) => !v)}
          className="text-sm px-3 py-1.5 rounded border"
          data-testid="notifications-prefs-toggle"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
        >
          Preferences
        </button>
      </div>

      {prefsOpen && prefs && (
        <div
          className="mb-6 p-4 rounded border"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
          data-testid="notifications-prefs-panel"
        >
          <div className="flex items-center gap-3 mb-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.in_app}
                onChange={(e) => savePrefs({ ...prefs, in_app: e.target.checked })}
              />
              In-app notifications
            </label>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <label className="text-sm">Email digest:</label>
            <select
              value={prefs.email_digest}
              onChange={(e) =>
                savePrefs({
                  ...prefs,
                  email_digest: e.target.value as Preferences["email_digest"],
                })
              }
              className="text-sm px-2 py-1 rounded border bg-transparent"
              style={{ borderColor: "var(--wp-dark-border, #222)" }}
            >
              {DIGEST_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <label className="text-sm">Timezone:</label>
            <input
              type="text"
              value={prefs.timezone}
              onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}
              onBlur={() => savePrefs(prefs)}
              className="text-sm px-2 py-1 rounded border bg-transparent"
              style={{ borderColor: "var(--wp-dark-border, #222)" }}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm">Quiet hours:</label>
            <input
              type="time"
              value={prefs.quiet_hours_start ?? ""}
              onChange={(e) =>
                setPrefs({ ...prefs, quiet_hours_start: e.target.value || null })
              }
              onBlur={() => savePrefs(prefs)}
              className="text-sm px-2 py-1 rounded border bg-transparent"
              style={{ borderColor: "var(--wp-dark-border, #222)" }}
            />
            <span className="text-xs" style={{ color: "var(--wp-text-muted, #888)" }}>
              to
            </span>
            <input
              type="time"
              value={prefs.quiet_hours_end ?? ""}
              onChange={(e) =>
                setPrefs({ ...prefs, quiet_hours_end: e.target.value || null })
              }
              onBlur={() => savePrefs(prefs)}
              className="text-sm px-2 py-1 rounded border bg-transparent"
              style={{ borderColor: "var(--wp-dark-border, #222)" }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {(["unread", "all", "category", "priority"] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`notifications-tab-${k}`}
            onClick={() => setTab(k)}
            className="px-3 py-1.5 text-sm rounded border"
            style={{
              borderColor: "var(--wp-dark-border, #222)",
              background: tab === k ? "var(--wp-dark-surface2, #222)" : "transparent",
              color: tab === k ? "var(--wp-gold, #d4af37)" : "var(--wp-text-dim, #aaa)",
            }}
          >
            {k === "unread"
              ? "Unread"
              : k === "all"
                ? "All"
                : k === "category"
                  ? "By category"
                  : "By priority"}
          </button>
        ))}
      </div>

      {tab === "category" && (
        <input
          type="text"
          placeholder="e.g. hr.onboarding_stalled"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="mb-3 w-full px-3 py-2 text-sm rounded border bg-transparent"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
          data-testid="notifications-category-input"
        />
      )}
      {tab === "priority" && (
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="mb-3 px-3 py-2 text-sm rounded border bg-transparent"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
          data-testid="notifications-priority-select"
        >
          <option value="">All priorities</option>
          <option value="critical">critical</option>
          <option value="high">high</option>
          <option value="normal">normal</option>
          <option value="low">low</option>
        </select>
      )}

      <div className="mb-3 flex gap-2">
        <input
          type="text"
          placeholder="Search title or body..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(false);
          }}
          className="flex-1 px-3 py-2 text-sm rounded border bg-transparent"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
          data-testid="notifications-search"
        />
        <button
          type="button"
          onClick={() => load(false)}
          className="px-3 py-2 text-sm rounded border"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
        >
          Search
        </button>
      </div>

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={markAll}
          data-testid="notifications-mark-all"
          className="px-3 py-1.5 text-xs rounded border"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
        >
          Mark all read
        </button>
        <button
          type="button"
          onClick={dismissRead}
          data-testid="notifications-dismiss-read"
          className="px-3 py-1.5 text-xs rounded border"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
        >
          Dismiss read
        </button>
      </div>

      <div
        className="rounded border divide-y"
        style={{ borderColor: "var(--wp-dark-border, #222)" }}
      >
        {loading && items.length === 0 && (
          <div className="p-6 text-sm text-center" style={{ color: "var(--wp-text-muted, #888)" }}>
            Loading...
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="p-6 text-sm text-center" style={{ color: "var(--wp-text-muted, #888)" }}>
            No notifications.
          </div>
        )}
        {items.map((n) => (
          <div
            key={n.id}
            className="p-3 flex gap-3 items-start"
            data-testid={`inbox-item-${n.id}`}
          >
            <div className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => handleClickItem(n)}
                className="block w-full text-left"
              >
                <div className="text-sm font-medium">
                  {n.title}
                  {!n.read_at && (
                    <span
                      className="ml-2 inline-block w-2 h-2 rounded-full"
                      style={{ background: "var(--wp-gold, #d4af37)" }}
                      aria-label="unread"
                    />
                  )}
                </div>
                {n.body && (
                  <div className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                    {n.body}
                  </div>
                )}
                <div className="text-[10px] mt-1" style={{ color: "var(--wp-text-muted, #888)" }}>
                  {n.category} • {n.priority} • {new Date(n.created_at).toLocaleString()}
                </div>
              </button>
            </div>
            <button
              type="button"
              onClick={() => handleDismiss(n.id)}
              className="text-xs"
              style={{ color: "var(--wp-text-muted, #888)" }}
              data-testid={`inbox-dismiss-${n.id}`}
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>

      {nextCursor && (
        <button
          type="button"
          onClick={() => {
            setCursor(nextCursor);
            load(true);
          }}
          className="mt-3 w-full px-3 py-2 text-sm rounded border"
          style={{ borderColor: "var(--wp-dark-border, #222)" }}
          data-testid="notifications-load-more"
        >
          Load more
        </button>
      )}
    </div>
  );
}
