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

  /** Poll for a SPECIFIC job's completion (by jobId returned from
   *  POST). Stops as soon as that job has endedAt. Bounded so the
   *  UI never busy-polls forever, with a clear "continuing in
   *  background" state if the poll cap is reached before completion. */
  async function pollSyncCompletion(sourceId: string, jobId: string) {
    const POLL_MS = 4000;
    const MAX_MS = 90 * 1000; // 90s cap, then surface "continuing in background"
    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const res = await fetchWithRefresh(
          `/api/connectors/sharepoint/sources/${encodeURIComponent(sourceId)}`,
        );
        if (!res.ok) continue;
        const data = await res.json();
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        /* Find OUR job by id, not by timestamp guessing. */
        const job = jobs.find((j: { id: string }) => j.id === jobId);
        if (job && job.endedAt) {
          await load();
          if (job.status === "failed" || job.error) {
            setSyncErrors((prev) => ({
              ...prev,
              [sourceId]:
                job.error ??
                `Sync failed (${job.failCount}/${job.fileCount} files).`,
            }));
          }
          return;
        }
      } catch {
        /* keep polling */
      }
    }
    /* Hit the poll cap. The job may still complete in the background;
     * reconciler will mark it failed if it stays stuck >6 min. Show
     * a clear "continuing" message so the user knows they can move on. */
    setSyncErrors((prev) => ({
      ...prev,
      [sourceId]:
        "Sync is still running in the background. Refresh this page in a few minutes to see the result.",
    }));
    await load();
  }

  async function handleSync(id: string) {
    setSyncingId(id);
    setSyncErrors((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    try {
      const res = await fetchWithRefresh(
        `/api/connectors/sharepoint/sources/${encodeURIComponent(id)}/sync`,
        { method: "POST", headers: jsonHeaders() },
      );
      /* 202 means the sync was accepted and is running in the
       * background. The response includes a jobId we poll for. */
      if (res.status === 202) {
        let jobId: string | undefined;
        try {
          const data = await res.json();
          jobId = typeof data?.jobId === "string" ? data.jobId : undefined;
        } catch {
          /* fall through; we'll just surface a generic completion */
        }
        if (jobId) {
          void pollSyncCompletion(id, jobId).finally(() => {
            setSyncingId((cur) => (cur === id ? null : cur));
          });
        } else {
          /* No jobId returned (older deploy?). Reload once and stop. */
          await load();
          setSyncingId(null);
        }
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
