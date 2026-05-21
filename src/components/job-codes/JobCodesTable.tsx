"use client";

/**
 * JobCodesTable — full-column mirror of the SharePoint workbook with
 * inline edit on the editable columns (Program / PO Number / PO
 * Amount, mapped from Excel D/E/F).
 *
 * Read columns (Code + Description + Client/Category + …) render as
 * plain text. Editable columns render as <input> fields that PATCH
 * the SharePoint cell on blur or Enter via /api/job-codes/[code]/cell.
 * Other team members' edits are never overwritten because the writer
 * is hard-allowlisted to D/E/F server-side; the UI also visually
 * marks those three columns as editable.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface JobCode {
  code: string;
  description: string;
  sheetName: string;
  active: boolean;
  lastSeenAt: string;
  extra: Record<string, string>;
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
  columns: string[];
  source: SourceInfo;
  served_stale: boolean;
  refreshed_now: boolean;
}

/* Workbook header text → Excel column letter. These are the only
   three columns Instinct can PATCH. Server enforces the same set;
   this map drives the UI affordance only. */
const EDITABLE_HEADER_TO_COLUMN: Record<string, "D" | "E" | "F"> = {
  "Program": "D",
  "PO Number": "E",
  "PO Amount": "F",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

function cellValue(row: JobCode, column: string): string {
  if (column === "Code") return row.code;
  if (column === "Description") return row.description;
  return row.extra?.[column] ?? "";
}

export function JobCodesTable() {
  const [codes, setCodes] = useState<JobCode[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [servedStale, setServedStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [canRefresh, setCanRefresh] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  /* Per-cell save state: keyed by `${code}__${column}` so two cells in
     the same row can be saving / errored independently. */
  const [cellState, setCellState] = useState<
    Record<string, { saving?: boolean; error?: string | null; savedAt?: number }>
  >({});

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
      setColumns(body.columns ?? ["Code", "Description"]);
      setSource(body.source);
      setServedStale(!!body.served_stale);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

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
      const res = await fetchWithRefresh("/api/job-codes/refresh", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        outcome?: { status: string; rowsAdded?: number; rowsUpdated?: number; rowsDeactivated?: number; error?: { code: string } };
      };
      if (res.ok && body.ok) {
        const o = body.outcome;
        setRefreshMessage(`Refreshed: +${o?.rowsAdded ?? 0}, ${o?.rowsUpdated ?? 0} updated, ${o?.rowsDeactivated ?? 0} removed`);
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

  const saveCell = useCallback(
    async (code: string, columnHeader: string, column: "D" | "E" | "F", value: string) => {
      const key = `${code}__${columnHeader}`;
      setCellState((s) => ({ ...s, [key]: { saving: true, error: null } }));
      track("cell_edit_started", { code, column_header: columnHeader });
      try {
        const res = await fetchWithRefresh(`/api/job-codes/${encodeURIComponent(code)}/cell`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ column, value }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          detail?: string;
          new_value?: string;
        };
        if (!res.ok || !body.ok) {
          setCellState((s) => ({
            ...s,
            [key]: { saving: false, error: body.error || `HTTP ${res.status}` },
          }));
          return false;
        }
        /* Optimistically reflect the saved value in the table. */
        setCodes((prev) =>
          prev.map((r) =>
            r.code === code
              ? { ...r, extra: { ...r.extra, [columnHeader]: body.new_value ?? value } }
              : r,
          ),
        );
        setCellState((s) => ({
          ...s,
          [key]: { saving: false, error: null, savedAt: Date.now() },
        }));
        return true;
      } catch (err) {
        setCellState((s) => ({
          ...s,
          [key]: { saving: false, error: (err as Error).message },
        }));
        return false;
      }
    },
    [track],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        Object.values(c.extra ?? {}).some((v) => v.toLowerCase().includes(q)),
    );
  }, [codes, search]);

  const freshnessTone = (() => {
    if (servedStale || !source?.lastRefreshedAt) return "warning";
    const age = Date.now() - new Date(source.lastRefreshedAt).getTime();
    if (age < 15 * 60_000) return "ok";
    if (age < 60 * 60_000) return "warning";
    return "error";
  })();
  const chipBg = freshnessTone === "ok" ? "rgba(74,222,128,0.12)" : freshnessTone === "warning" ? "rgba(234,179,8,0.12)" : "rgba(248,113,113,0.12)";
  const chipColor = freshnessTone === "ok" ? "#4ade80" : freshnessTone === "warning" ? "#eab308" : "#f87171";

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
          placeholder="Search by code, description, or any column…"
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
            {refreshing ? "Refreshing…" : "Refresh now"}
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
          style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text-dim, #aaa)" }}
        >
          {refreshMessage}
        </div>
      )}

      {loading && (
        <div data-testid="job-codes-loading" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Loading job codes…
        </div>
      )}

      {error && !loading && (
        <div
          data-testid="job-codes-error"
          className="text-sm rounded px-3 py-2"
          style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}
        >
          Couldn&apos;t load codes: {error}. Try Refresh, or check that the SharePoint workbook is reachable.
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div data-testid="job-codes-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          {search.trim() ? `No codes match "${search}".` : "No codes in the cache yet. Press Refresh to sync from SharePoint."}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="rounded overflow-x-auto" style={{ border: "1px solid var(--wp-dark-border, #333)" }}>
          <table className="w-full text-sm">
            <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
              <tr>
                {columns.map((col) => {
                  const isEditable = !!EDITABLE_HEADER_TO_COLUMN[col];
                  return (
                    <th
                      key={col}
                      data-testid={`job-codes-header-${col}`}
                      className="text-left px-3 py-2 whitespace-nowrap"
                      style={{ color: "var(--wp-text-dim, #aaa)" }}
                    >
                      {col}
                      {isEditable && (
                        <span
                          className="ml-1 text-[10px]"
                          style={{ color: "var(--wp-gold, #eab308)" }}
                          title="Editable — saved to SharePoint on blur"
                        >
                          (editable)
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.code}
                  data-testid={`job-code-row-${row.code}`}
                  style={{ borderTop: "1px solid var(--wp-dark-border, #333)" }}
                >
                  {columns.map((col) => {
                    const editableColumn = EDITABLE_HEADER_TO_COLUMN[col];
                    const v = cellValue(row, col);
                    if (!editableColumn) {
                      return (
                        <td
                          key={col}
                          data-testid={`cell-${row.code}-${col}`}
                          className="px-3 py-2 align-top"
                          style={{ color: col === "Code" ? "var(--wp-text, #eee)" : "var(--wp-text-dim, #aaa)", fontFamily: col === "Code" ? "monospace" : undefined }}
                        >
                          {v || "—"}
                        </td>
                      );
                    }
                    return (
                      <EditableCell
                        key={col}
                        row={row}
                        columnHeader={col}
                        column={editableColumn}
                        initialValue={v}
                        cellState={cellState[`${row.code}__${col}`]}
                        canEdit={canRefresh}
                        onSave={(value) => saveCell(row.code, col, editableColumn, value)}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface EditableCellProps {
  row: JobCode;
  columnHeader: string;
  column: "D" | "E" | "F";
  initialValue: string;
  cellState?: { saving?: boolean; error?: string | null; savedAt?: number };
  canEdit: boolean;
  onSave: (value: string) => Promise<boolean>;
}

function EditableCell({ row, columnHeader, initialValue, cellState, canEdit, onSave }: EditableCellProps) {
  const [value, setValue] = useState(initialValue);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    /* Reflect upstream value changes (e.g. after a Refresh) only when
       the cell isn't dirty — don't blow away an in-progress edit. */
    if (!dirty) setValue(initialValue);
  }, [initialValue, dirty]);

  const handleSave = async () => {
    if (!dirty || value === initialValue) return;
    const ok = await onSave(value);
    if (ok) setDirty(false);
  };

  const saving = !!cellState?.saving;
  const error = cellState?.error;
  const recentlySaved = cellState?.savedAt && Date.now() - cellState.savedAt < 4_000;

  if (!canEdit) {
    return (
      <td
        data-testid={`cell-${row.code}-${columnHeader}`}
        className="px-3 py-2 align-top"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        {value || "—"}
      </td>
    );
  }

  return (
    <td
      data-testid={`cell-${row.code}-${columnHeader}`}
      className="px-3 py-2 align-top"
    >
      <input
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setDirty(true);
        }}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void handleSave();
          }
        }}
        disabled={saving}
        data-testid={`cell-input-${row.code}-${columnHeader}`}
        placeholder="—"
        className="w-full px-2 py-1 text-sm rounded"
        style={{
          background: "var(--wp-dark, #111)",
          border: `1px solid ${error ? "#f87171" : recentlySaved ? "#4ade80" : "var(--wp-dark-border, #333)"}`,
          color: "var(--wp-text, #eee)",
          fontSize: "16px",
        }}
      />
      {error && (
        <div
          data-testid={`cell-error-${row.code}-${columnHeader}`}
          className="text-[10px] mt-1"
          style={{ color: "#f87171" }}
        >
          {error}
        </div>
      )}
      {saving && (
        <div className="text-[10px] mt-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
          Saving…
        </div>
      )}
    </td>
  );
}
