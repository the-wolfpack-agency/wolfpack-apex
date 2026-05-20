"use client";

/**
 * JobCodesTable — read-only, searchable, with admin "Refresh now."
 *
 * Mounts → GET /api/job-codes. Renders a freshness chip (green when
 * <15 min, amber when stale, red when Graph just failed). Search
 * filters client-side by code OR description. Admins (capability
 * `jobcodes.refresh`) see a "Refresh now" button that hits the
 * refresh endpoint and reloads the list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface JobCode {
  code: string;
  description: string;
  sheetName: string;
  active: boolean;
  lastSeenAt: string;
}

interface SourceInfo {
  driveId: string | null;
  itemId: string | null;
  webUrl: string | null;
  sheetName: string | null;
  lastRefreshedAt: string | null;
  lastAttemptedAt: string | null;
  lastAttemptStatus: string | null;
  lastAttemptError: string | null;
}

interface CodesResponse {
  codes: JobCode[];
  source: SourceInfo;
  served_stale: boolean;
  refreshed_now: boolean;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

export function JobCodesTable() {
  const [codes, setCodes] = useState<JobCode[]>([]);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [servedStale, setServedStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [canRefresh, setCanRefresh] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  const track = useCallback((event: string, metadata: Record<string, unknown> = {}) => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: `jobcodes.${event}`, metadata }),
    }).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/job-codes");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setCodes([]);
        return;
      }
      const body = (await res.json()) as CodesResponse;
      setCodes(body.codes);
      setSource(body.source);
      setServedStale(!!body.served_stale);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  /* Capability probe — the API responds 403 for non-admins, so we
     just try the refresh endpoint with no body and a HEAD-equivalent
     check via OPTIONS? Easier: hit /api/me/capabilities which
     already exists and gates the refresh button. */
  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { capabilities?: string[] } | null) => {
        if (body?.capabilities?.includes("jobcodes.refresh")) {
          setCanRefresh(true);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
    track("page_viewed");
  }, [load, track]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshMessage(null);
    track("refresh_clicked");
    try {
      const res = await fetchWithRefresh("/api/job-codes/refresh", {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        outcome?: { status: string; rowsAdded?: number; rowsUpdated?: number; rowsDeactivated?: number; error?: { code: string; detail: string } };
      };
      if (res.ok && body.ok) {
        const o = body.outcome;
        setRefreshMessage(
          `Refreshed: +${o?.rowsAdded ?? 0} new, ${o?.rowsUpdated ?? 0} updated, ${o?.rowsDeactivated ?? 0} removed`,
        );
        await load();
      } else {
        const reason = body.outcome?.error?.code ?? `HTTP ${res.status}`;
        setRefreshMessage(`Refresh failed: ${reason}`);
      }
    } catch (err) {
      setRefreshMessage(`Refresh failed: ${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }, [load, track]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [codes, search]);

  /* Freshness chip color: green <15 min, amber <60 min, red otherwise. */
  const freshnessTone = (() => {
    if (servedStale || !source?.lastRefreshedAt) return "warning";
    const age = Date.now() - new Date(source.lastRefreshedAt).getTime();
    if (age < 15 * 60_000) return "ok";
    if (age < 60 * 60_000) return "warning";
    return "error";
  })();

  const chipBg =
    freshnessTone === "ok"
      ? "rgba(74,222,128,0.12)"
      : freshnessTone === "warning"
        ? "rgba(234,179,8,0.12)"
        : "rgba(248,113,113,0.12)";
  const chipColor =
    freshnessTone === "ok"
      ? "#4ade80"
      : freshnessTone === "warning"
        ? "#eab308"
        : "#f87171";

  return (
    <div data-testid="job-codes-table" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (e.target.value.length > 2) track("searched", { len: e.target.value.length });
          }}
          placeholder="Search by code or description..."
          data-testid="job-codes-search"
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded"
          style={{
            background: "var(--wp-dark-surface2, #1a1a1a)",
            border: "1px solid var(--wp-dark-border, #333)",
            color: "var(--wp-text, #eee)",
            fontSize: "16px",
          }}
        />
        <span
          data-testid="job-codes-freshness"
          className="text-xs rounded px-2 py-1"
          style={{ background: chipBg, color: chipColor, border: `1px solid ${chipColor}` }}
        >
          {servedStale
            ? `Stale — SharePoint unreachable (last synced ${ago(source?.lastRefreshedAt ?? null)})`
            : source?.lastRefreshedAt
              ? `Synced ${ago(source.lastRefreshedAt)}`
              : "Never synced"}
        </span>
        {canRefresh && (
          <button
            type="button"
            data-testid="job-codes-refresh"
            disabled={refreshing}
            onClick={onRefresh}
            className="px-3 py-2 text-xs font-medium rounded"
            style={{
              background: refreshing ? "var(--wp-dark-surface2, #1a1a1a)" : "var(--wp-gold, #eab308)",
              color: refreshing ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
              border: "none",
              cursor: refreshing ? "not-allowed" : "pointer",
            }}
          >
            {refreshing ? "Refreshing..." : "Refresh now"}
          </button>
        )}
        {source?.webUrl && (
          <a
            href={source.webUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="job-codes-source-link"
            className="text-xs underline"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
          >
            Open source workbook
          </a>
        )}
      </div>

      {refreshMessage && (
        <div
          data-testid="job-codes-refresh-message"
          className="text-xs rounded px-3 py-2"
          style={{
            background: "var(--wp-dark-surface2, #1a1a1a)",
            border: "1px solid var(--wp-dark-border, #333)",
            color: "var(--wp-text-dim, #aaa)",
          }}
        >
          {refreshMessage}
        </div>
      )}

      {loading && (
        <div data-testid="job-codes-loading" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Loading job codes...
        </div>
      )}

      {error && !loading && (
        <div
          data-testid="job-codes-error"
          className="text-sm rounded px-3 py-2"
          style={{
            background: "rgba(248,113,113,0.08)",
            border: "1px solid #f87171",
            color: "#f87171",
          }}
        >
          Couldn&apos;t load codes: {error}. Try Refresh, or check that the
          SharePoint workbook is reachable.
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div
          data-testid="job-codes-empty"
          className="text-sm"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          {search.trim()
            ? `No codes match "${search}".`
            : "No codes in the cache yet. Press Refresh to sync from SharePoint."}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div
          className="rounded overflow-hidden"
          style={{ border: "1px solid var(--wp-dark-border, #333)" }}
        >
          <table className="w-full text-sm">
            <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
              <tr>
                <th className="text-left px-3 py-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  Code
                </th>
                <th className="text-left px-3 py-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  Description
                </th>
                <th className="text-left px-3 py-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  Sheet
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.code}
                  data-testid={`job-code-row-${c.code}`}
                  style={{ borderTop: "1px solid var(--wp-dark-border, #333)" }}
                >
                  <td className="px-3 py-2 font-mono" style={{ color: "var(--wp-text, #eee)" }}>
                    {c.code}
                  </td>
                  <td className="px-3 py-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                    {c.description || "—"}
                  </td>
                  <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                    {c.sheetName || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
