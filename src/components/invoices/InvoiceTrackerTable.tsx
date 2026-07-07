"use client";

/**
 * InvoiceTrackerTable — read-only, full-column mirror of one company's
 * SharePoint invoice workbook (the "Summary" tab). Fetches
 * /api/invoices/{company}; renders whatever columns the sheet has. Styled to
 * match /job-codes (the feature this mirrors): a search box, a colored
 * freshness chip, a gold "Refresh now" button, and an "Open source workbook"
 * link. Handles every state so the page never blanks: loading, forbidden (not
 * on the allowlist), empty/not-connected, stale (Graph down, showing last-good).
 * Authed client fetches go through fetchWithRefresh (never raw fetch) per the
 * repo guardrail.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

export function InvoiceTrackerTable({ company }: { company: string }) {
  const [view, setView] = useState<View>("loading");
  const [data, setData] = useState<Payload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [search, setSearch] = useState("");

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

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) => Object.values(r).some((v) => v.toLowerCase().includes(q)));
  }, [data, search]);

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
        <button type="button" className="mt-2 px-3 py-2 text-xs font-medium rounded" style={{ background: "var(--wp-gold, #eab308)", color: "var(--wp-dark, #111)", border: "none", cursor: "pointer" }} onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  // Freshness chip tone mirrors JobCodesTable: green fresh, amber aging/stale, red old.
  const tone = (() => {
    if (data.served_stale || !data.last_refreshed_at) return "warning";
    const age = Date.now() - new Date(data.last_refreshed_at).getTime();
    if (age < 15 * 60_000) return "ok";
    if (age < 60 * 60_000) return "warning";
    return "error";
  })();
  const chipBg = tone === "ok" ? "rgba(74,222,128,0.12)" : tone === "warning" ? "rgba(234,179,8,0.12)" : "rgba(248,113,113,0.12)";
  const chipColor = tone === "ok" ? "#4ade80" : tone === "warning" ? "#eab308" : "#f87171";
  const empty = data.rows.length === 0;

  return (
    <div data-testid="invoice-tracker" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search any column…"
          data-testid="invoice-tracker-search"
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded"
          style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
        />
        <span
          data-testid="invoice-tracker-freshness"
          className="text-xs rounded px-2 py-1"
          style={{ background: chipBg, color: chipColor, border: `1px solid ${chipColor}` }}
        >
          {data.served_stale
            ? `Stale — SharePoint unreachable (last synced ${ago(data.last_refreshed_at)})`
            : data.last_refreshed_at
              ? `Synced ${ago(data.last_refreshed_at)}`
              : "Never synced"}
        </span>
        <button
          type="button"
          data-testid="invoice-tracker-refresh"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="px-3 py-2 text-xs font-medium rounded"
          style={{
            background: refreshing ? "var(--wp-dark-surface2, #1a1a1a)" : "var(--wp-gold, #eab308)",
            color: refreshing ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
            border: "none",
            cursor: refreshing ? "not-allowed" : "pointer",
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
        {data.web_url ? (
          <a href={data.web_url} target="_blank" rel="noopener noreferrer" data-testid="invoice-tracker-open" className="text-xs underline" style={{ color: "var(--wp-text-dim, #aaa)" }}>
            Open source workbook
          </a>
        ) : null}
      </div>

      {refreshError ? (
        <div className="text-xs rounded px-3 py-2" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }} data-testid="invoice-tracker-refresh-error">{refreshError}</div>
      ) : null}

      {empty ? (
        <div data-testid="invoice-tracker-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No rows yet. {ERROR_HINT[data.error_code ?? ""] ?? "Click Refresh now to pull the latest from SharePoint."}
        </div>
      ) : filtered.length === 0 ? (
        <div data-testid="invoice-tracker-no-match" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No rows match “{search}”.
        </div>
      ) : (
        <div className="rounded overflow-x-auto" style={{ border: "1px solid var(--wp-dark-border, #333)" }}>
          <table className="w-full text-sm" data-testid="invoice-tracker-table">
            <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
              <tr>
                {data.columns.map((c) => (
                  <th key={c} className="text-left px-3 py-2 whitespace-nowrap" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i} data-testid="invoice-tracker-row" style={{ borderTop: "1px solid var(--wp-dark-border, #333)" }}>
                  {data.columns.map((c) => (
                    <td key={c} className="px-3 py-2 align-top whitespace-pre-wrap" style={{ color: "var(--wp-text-dim, #ccc)" }}>
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
