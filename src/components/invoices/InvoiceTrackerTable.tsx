"use client";

/**
 * InvoiceTrackerTable — read-only, full-column mirror of one company's
 * SharePoint invoice workbook (the "Summary" tab). Fetches
 * /api/invoices/{company}; renders whatever columns the sheet has. Handles
 * every state so the page never blanks: loading, forbidden (not on the
 * allowlist), empty/not-connected, stale (Graph down, showing last-good), and a
 * "Refresh now" that forces a live Graph re-pull. Authed client fetches go
 * through fetchWithRefresh (never raw fetch) per the repo guardrail.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Payload {
  company: string;
  sheet: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  source: "cache" | "fresh" | "stale" | "empty";
  served_stale: boolean;
  last_refreshed_at: string | null;
  web_url: string | null;
  error_code: string | null;
}

type View = "loading" | "ok" | "forbidden" | "error";

const ERROR_HINT: Record<string, string> = {
  no_token: "Connect your Microsoft account in Settings, then Refresh — the workbook is read through your login.",
  forbidden: "Your Microsoft account can’t open this SharePoint file. Ask the owner to share it with you.",
  not_found: "The source workbook could not be found. The share link may have moved.",
  graph_error: "Microsoft returned an error. Try Refresh again in a moment.",
  empty: "The workbook or its Summary sheet is empty.",
};

export function InvoiceTrackerTable({ company }: { company: string }) {
  const [view, setView] = useState<View>("loading");
  const [data, setData] = useState<Payload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh(`/api/invoices/${encodeURIComponent(company)}`);
      if (res.status === 403) {
        setView("forbidden");
        return;
      }
      if (!res.ok) {
        setView("error");
        return;
      }
      setData((await res.json()) as Payload);
      setView("ok");
    } catch {
      setView("error");
    }
  }, [company]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      const res = await fetchWithRefresh(`/api/invoices/${encodeURIComponent(company)}/refresh`, { method: "POST" });
      if (res.status === 403) {
        setView("forbidden");
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefreshError(ERROR_HINT[body?.error_code as string] || "Could not refresh from SharePoint.");
        return;
      }
      setData(body as Payload);
      setView("ok");
    } catch {
      setRefreshError("Something went wrong. Please try again.");
    } finally {
      setRefreshing(false);
    }
  }

  if (view === "loading") {
    return <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }} data-testid="invoice-tracker-loading">Loading…</p>;
  }
  if (view === "forbidden") {
    return (
      <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }} data-testid="invoice-tracker-forbidden">
        You don’t have access to this invoice tracker.
      </p>
    );
  }
  if (view === "error" || !data) {
    return (
      <div data-testid="invoice-tracker-error">
        <p className="text-sm" style={{ color: "var(--wp-error, #ef4444)" }}>We couldn’t load this tracker.</p>
        <button type="button" className="wp-btn mt-2" onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  const empty = data.rows.length === 0;
  return (
    <div data-testid="invoice-tracker">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }} data-testid="invoice-tracker-meta">
          {data.served_stale ? "Showing last-synced copy — " : ""}
          {data.last_refreshed_at ? `Synced ${new Date(data.last_refreshed_at).toLocaleString()}` : "Not synced yet"}
          {" · "}
          {data.rows.length} row{data.rows.length === 1 ? "" : "s"}
        </p>
        <div className="flex items-center gap-2">
          {data.web_url ? (
            <a href={data.web_url} target="_blank" rel="noopener noreferrer" className="text-xs underline" style={{ color: "var(--wp-accent, #d5001c)" }} data-testid="invoice-tracker-open">
              Open in SharePoint
            </a>
          ) : null}
          <button type="button" className="wp-btn" onClick={() => void refresh()} disabled={refreshing} data-testid="invoice-tracker-refresh">
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </div>

      {refreshError ? (
        <p className="text-sm mb-2" style={{ color: "var(--wp-error, #ef4444)" }} data-testid="invoice-tracker-refresh-error">{refreshError}</p>
      ) : null}

      {empty ? (
        <div data-testid="invoice-tracker-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No rows yet. {ERROR_HINT[data.error_code ?? ""] ?? "Click Refresh now to pull the latest from SharePoint."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--wp-border, #333)" }}>
          <table className="w-full text-sm" data-testid="invoice-tracker-table">
            <thead>
              <tr>
                {data.columns.map((c) => (
                  <th key={c} className="text-left px-3 py-2 whitespace-nowrap font-semibold" style={{ background: "var(--wp-surface, #1a1a1a)", color: "var(--wp-text, #eee)", borderBottom: "1px solid var(--wp-border, #333)" }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i} data-testid="invoice-tracker-row">
                  {data.columns.map((c) => (
                    <td key={c} className="px-3 py-2 align-top whitespace-pre-wrap" style={{ color: "var(--wp-text-dim, #ccc)", borderBottom: "1px solid var(--wp-border, #262626)" }}>
                      {r[c] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
