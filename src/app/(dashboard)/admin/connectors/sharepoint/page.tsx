"use client";

/**
 * /admin/connectors/sharepoint
 *
 * Admin UI for managing SharePoint folder sources. Lists existing
 * sources, lets the operator add a new one (paste folder URL + name),
 * trigger a sync, and remove. Recent job history surfaces per source.
 *
 * Plain language only. Errors are full sentences.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type {
  SharepointSource,
  IngestJob,
} from "@/lib/connectors/sharepoint/types";

interface SourceWithJobs extends SharepointSource {
  jobs?: IngestJob[];
}

export default function AdminSharepointPage() {
  const [sources, setSources] = useState<SourceWithJobs[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [adding, setAdding] = useState(false);
  /* Two separate error channels so a sync failure doesn't render
   * inside the Add Source form (the previous shared-state bug). */
  const [addError, setAddError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithRefresh("/api/connectors/sharepoint/sources");
      if (!res.ok) throw new Error("load_failed");
      const data = await res.json();
      setSources(data.sources ?? []);
    } catch (err) {
      /* Load errors surface in the global add-error slot since they
       * affect the whole page, not a single row. */
      setAddError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* Note: we used to also have a generic 4s poll that reloaded the
   * sources list while syncingId was non-null. That created an
   * "infinite refresh" feel even when the targeted job poller had
   * everything under control. Targeted pollSyncCompletion() now
   * handles its own reload on completion — we don't need a second
   * poll. */

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    try {
      const res = await fetchWithRefresh("/api/connectors/sharepoint/sources", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: name.trim(), siteUrl: siteUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error ?? "Couldn't add the source.");
        return;
      }
      setName("");
      setSiteUrl("");
      await load();
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleSync(id: string) {
    setSyncingId(id);
    setSyncErrors((prev) => {
      const { [id]: _unused, ...rest } = prev;
      return rest;
    });
    try {
      /* Synchronous sync: the route awaits syncSource() so the
       * response is the final result. No polling, no job-id juggling,
       * no infinite refresh. Bounded by the route's maxDuration
       * (300s on Pro). Large folders that exceed that need the
       * Clear stuck button + a separate queue worker (TODO). */
      const res = await fetchWithRefresh(
        `/api/connectors/sharepoint/sources/${encodeURIComponent(id)}/sync`,
        { method: "POST", headers: jsonHeaders() },
      );
      let data: { result?: { status?: string; successCount?: number; failCount?: number; fileCount?: number; error?: string | null }; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        /* If the body isn't JSON it's almost certainly a Vercel
         * timeout HTML page; tell the user directly. */
        setSyncErrors((prev) => ({
          ...prev,
          [id]: `Sync timed out (HTTP ${res.status}). Folder may be too large for one sync. Try a smaller subfolder.`,
        }));
        return;
      }
      if (!res.ok) {
        const errMsg =
          data?.result?.error ??
          data?.error ??
          `Sync failed (HTTP ${res.status}).`;
        setSyncErrors((prev) => ({ ...prev, [id]: errMsg }));
      } else if (data.result?.status === "partial") {
        setSyncErrors((prev) => ({
          ...prev,
          [id]: `Sync finished with errors (${data.result?.failCount}/${data.result?.fileCount} files failed).`,
        }));
      }
      await load();
    } catch (err) {
      setSyncErrors((prev) => ({ ...prev, [id]: (err as Error).message }));
    } finally {
      setSyncingId(null);
    }
  }

  async function handleClearStuck(id: string) {
    if (!confirm("Force-mark all running syncs for this source as failed? Use this if a sync is hung.")) return;
    try {
      const res = await fetchWithRefresh(
        `/api/connectors/sharepoint/sources/${encodeURIComponent(id)}/clear-stuck`,
        { method: "POST", headers: jsonHeaders() },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSyncErrors((prev) => ({ ...prev, [id]: data?.error ?? "Couldn't clear stuck syncs." }));
      } else {
        setSyncErrors((prev) => {
          const { [id]: _unused, ...rest } = prev;
          return rest;
        });
      }
      await load();
    } catch (err) {
      setSyncErrors((prev) => ({ ...prev, [id]: (err as Error).message }));
    }
  }

  async function handleRemove(id: string) {
    if (!confirm("Remove this SharePoint source? Indexed files stay in the brain; future syncs stop.")) return;
    try {
      const res = await fetchWithRefresh(
        `/api/connectors/sharepoint/sources/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json();
        setSyncErrors((prev) => ({
          ...prev,
          [id]: data?.error ?? "Couldn't remove source.",
        }));
        return;
      }
      await load();
    } catch (err) {
      setSyncErrors((prev) => ({ ...prev, [id]: (err as Error).message }));
    }
  }

  return (
    <main className="p-6 max-w-4xl mx-auto" data-testid="admin-sharepoint-page">
      <h1 className="text-2xl font-bold mb-2" style={{ color: "var(--wp-gold, #eab308)" }}>
        SharePoint sources
      </h1>
      <p className="text-sm mb-6" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
        Configure SharePoint folders that Instinct should ingest into the central
        knowledge base. New files added to the folder become searchable in chat
        after the next sync.
      </p>

      <form
        onSubmit={handleAdd}
        data-testid="add-source-form"
        className="rounded-md p-4 mb-6"
        style={{
          background: "var(--wp-dark-surface, #1a1a1a)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        <div className="text-sm font-semibold mb-3" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Add a new source
        </div>
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Display name (what the team will call it)
        </label>
        <input
          data-testid="add-source-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="PCNA Program Evals"
          className="w-full mb-3 rounded px-3 py-2 text-sm"
          style={{
            background: "var(--wp-dark, #111)",
            color: "var(--wp-text, #eee)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
        />
        <label className="block text-xs mb-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          SharePoint folder URL
        </label>
        <input
          data-testid="add-source-url"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          placeholder="https://yourcompany.sharepoint.com/sites/.../Shared%20Documents/..."
          className="w-full mb-3 rounded px-3 py-2 text-sm"
          style={{
            background: "var(--wp-dark, #111)",
            color: "var(--wp-text, #eee)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
        />
        <button
          type="submit"
          disabled={adding || !name.trim() || !siteUrl.trim()}
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: "var(--wp-gold, #eab308)", color: "var(--wp-dark, #111)" }}
        >
          {adding ? "Adding..." : "Add source"}
        </button>
        {addError && (
          <div
            data-testid="add-source-error"
            className="mt-3 rounded p-2 text-xs"
            style={{
              background: "rgba(239,68,68,0.10)",
              border: "1px solid rgba(239,68,68,0.4)",
              color: "var(--wp-error, #ef4444)",
            }}
          >
            {addError}
          </div>
        )}
      </form>

      <div className="text-sm font-semibold mb-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        Configured sources
      </div>
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-muted, #6b7280)" }}>Loading...</p>
      ) : sources.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
          No sources configured yet. Add one above.
        </p>
      ) : (
        <ul className="space-y-3">
          {sources.map((s) => (
            <li
              key={s.id}
              data-testid={`source-row-${s.id}`}
              className="rounded-md p-3"
              style={{
                background: "var(--wp-dark-surface, #1a1a1a)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
                    {s.name}
                  </div>
                  <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                    {s.folderPath || "(library root)"}
                    {s.lastSyncedAt
                      ? ` · last synced ${new Date(s.lastSyncedAt).toLocaleString()}`
                      : " · never synced"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSync(s.id)}
                    disabled={syncingId === s.id}
                    data-testid={`sync-btn-${s.id}`}
                    className="text-xs px-3 py-1 rounded disabled:opacity-40"
                    style={{
                      background: "rgba(234,179,8,0.10)",
                      border: "1px solid rgba(234,179,8,0.4)",
                      color: "var(--wp-gold, #eab308)",
                    }}
                  >
                    {syncingId === s.id ? "Syncing..." : "Sync now"}
                  </button>
                  <button
                    onClick={() => handleClearStuck(s.id)}
                    data-testid={`clear-stuck-btn-${s.id}`}
                    className="text-xs px-3 py-1 rounded"
                    style={{
                      background: "var(--wp-dark-surface2, #222)",
                      border: "1px solid var(--wp-dark-border, #555)",
                      color: "var(--wp-text-dim, #aaa)",
                    }}
                    title="Force-mark any hung sync as failed"
                  >
                    Clear stuck
                  </button>
                  <button
                    onClick={() => handleRemove(s.id)}
                    data-testid={`remove-btn-${s.id}`}
                    className="text-xs px-3 py-1 rounded"
                    style={{
                      background: "rgba(239,68,68,0.10)",
                      border: "1px solid rgba(239,68,68,0.4)",
                      color: "var(--wp-error, #ef4444)",
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              {syncErrors[s.id] && (
                <div
                  data-testid={`sync-error-${s.id}`}
                  className="mt-2 rounded p-2 text-xs"
                  style={{
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.4)",
                    color: "var(--wp-error, #ef4444)",
                  }}
                >
                  {syncErrors[s.id]}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
