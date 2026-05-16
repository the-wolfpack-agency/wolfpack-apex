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

  /* Background poll: while ANY source is currently syncing, refresh
   * the list every 4 seconds so last_synced_at + status updates flow
   * in without a manual reload. Stops when no syncs are in flight. */
  useEffect(() => {
    if (!syncingId) return;
    const handle = setInterval(() => {
      void load();
    }, 4000);
    return () => clearInterval(handle);
  }, [syncingId, load]);

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

  /** Poll the source's GET endpoint until the latest job has an
   *  ended_at (meaning the background sync finished). Caps at a few
   *  minutes so a runaway job doesn't poll forever. */
  async function pollSyncCompletion(id: string, startedBefore: string) {
    const POLL_MS = 4000;
    const MAX_MS = 6 * 60 * 1000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const res = await fetchWithRefresh(
          `/api/connectors/sharepoint/sources/${encodeURIComponent(id)}`,
        );
        if (!res.ok) continue;
        const data = await res.json();
        const latestJob = Array.isArray(data?.jobs) ? data.jobs[0] : null;
        if (latestJob && latestJob.startedAt > startedBefore && latestJob.endedAt) {
          await load();
          if (latestJob.status === "failed" || latestJob.error) {
            setSyncErrors((prev) => ({
              ...prev,
              [id]:
                latestJob.error ??
                `Sync failed (${latestJob.failCount}/${latestJob.fileCount} files).`,
            }));
          }
          return;
        }
      } catch {
        /* keep polling */
      }
    }
    /* Timed out polling; surface a soft warning. The job may still
     * complete in the background. */
    setSyncErrors((prev) => ({
      ...prev,
      [id]: "Sync is taking longer than expected. Check back in a few minutes.",
    }));
    await load();
  }

  async function handleSync(id: string) {
    setSyncingId(id);
    setSyncErrors((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    const startedBefore = new Date().toISOString();
    try {
      const res = await fetchWithRefresh(
        `/api/connectors/sharepoint/sources/${encodeURIComponent(id)}/sync`,
        { method: "POST", headers: jsonHeaders() },
      );
      /* 202 means the sync was accepted and is running in the
       * background. We start polling for completion. */
      if (res.status === 202) {
        void pollSyncCompletion(id, startedBefore).finally(() => {
          setSyncingId((cur) => (cur === id ? null : cur));
        });
        return;
      }
      /* Anything else is an immediate-fail path. */
      let errMsg = `Sync failed (HTTP ${res.status}).`;
      try {
        const data = await res.json();
        errMsg = data?.error ?? errMsg;
      } catch {
        /* response wasn't JSON */
      }
      setSyncErrors((prev) => ({ ...prev, [id]: errMsg }));
      setSyncingId(null);
    } catch (err) {
      setSyncErrors((prev) => ({ ...prev, [id]: (err as Error).message }));
      setSyncingId(null);
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
