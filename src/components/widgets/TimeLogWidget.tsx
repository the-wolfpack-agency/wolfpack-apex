"use client";

/**
 * TimeLogWidget — cascading Client/Category → Job Code picker that
 * lets a user fill in / update the three editable workbook columns
 * (Program / PO Number / PO Amount) from inside the assistant chat.
 *
 * The form mirrors what /job-codes does inline, but optimized for
 * "I want to pick the right row fast" instead of "browse all rows":
 *   1. Pick Client / Category (column B) — filters the dropdown.
 *   2. Pick Job Code (column C) — filtered by the chosen client.
 *   3. Read the current Program / PO Number / PO Amount.
 *   4. Update any of the three and submit → PATCH each changed cell
 *      via /api/job-codes/[code]/cell. Server enforces the same
 *      D/E/F allowlist as the page — the widget never writes B or C.
 *
 * Backed by the same SharePoint catalog as the /job-codes page, so
 * what the user sees here matches what finance sees in the workbook.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { TimeLogWidgetSpec } from "@/lib/assistant/widgets/types";

interface JobCode {
  code: string;
  description: string;
  extra: Record<string, string>;
}

interface CodesResponse {
  codes: JobCode[];
  columns: string[];
}

/* Headers the user can EDIT through this widget. Must match the
 * server-side allowlist in cell-writer.ts (D/E/F). */
const EDITABLE_HEADERS = ["Program", "PO Number", "PO Amount"] as const;
type EditableHeader = (typeof EDITABLE_HEADERS)[number];

const HEADER_TO_COLUMN: Record<EditableHeader, "D" | "E" | "F"> = {
  "Program": "D",
  "PO Number": "E",
  "PO Amount": "F",
};

/* Workbook column header for Client/Category. Centralized so the
 * widget doesn't sprinkle the literal string everywhere — if finance
 * renames it, change this constant only. */
const CATEGORY_HEADER = "Client/Category";

export interface TimeLogWidgetProps {
  spec: TimeLogWidgetSpec;
  workflowId?: string;
}

export function TimeLogWidget({ spec, workflowId }: TimeLogWidgetProps) {
  const [catalog, setCatalog] = useState<JobCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [jobCode, setJobCode] = useState<string>(spec.jobCode ?? "");
  /* Field values mirror current cache; edits override locally until
     submit. Reset when the picked code changes. */
  const [values, setValues] = useState<Record<EditableHeader, string>>({
    "Program": "",
    "PO Number": "",
    "PO Amount": "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<
    Array<{ header: EditableHeader; ok: boolean; detail?: string; newValue?: string }>
  >([]);

  const track = useCallback(
    (action: string, value?: Record<string, unknown>) => {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "assistant.widget_interaction",
          metadata: {
            widget_kind: "time_log",
            action,
            ...(value ?? {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
          },
        }),
      }).catch(() => undefined);
    },
    [workflowId],
  );

  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { capabilities?: string[] } | null) => {
        if (body?.capabilities?.includes("jobcodes.refresh")) setCanEdit(true);
      })
      .catch(() => undefined);
    /* Tell the learning loop the user opened the widget — separate
       from the assistant.widget_offered event the tool emits, so we
       can compute open-rate vs offer-rate. */
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: { widget_kind: "time_log", ...(workflowId ? { workflow_id: workflowId } : {}) },
      }),
    }).catch(() => undefined);
  }, [workflowId]);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchWithRefresh("/api/job-codes");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLoadError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as CodesResponse;
      setCatalog(body.codes ?? []);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  /* Distinct Client/Category values, alphabetized. Codes without a
     value still surface under "(no category)" so they're reachable. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of catalog) {
      const v = (r.extra?.[CATEGORY_HEADER] ?? "").trim();
      set.add(v || "(no category)");
    }
    return [...set].sort();
  }, [catalog]);

  const filteredCodes = useMemo(() => {
    if (!category) return [];
    return catalog
      .filter((r) => {
        const v = (r.extra?.[CATEGORY_HEADER] ?? "").trim();
        if (category === "(no category)") return !v;
        return v === category;
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [catalog, category]);

  const selected = useMemo(
    () => catalog.find((r) => r.code === jobCode) ?? null,
    [catalog, jobCode],
  );

  /* When the user picks a different code, pull its current values
     into the form so they're editing the right baseline. */
  useEffect(() => {
    if (selected) {
      setValues({
        "Program": selected.extra?.["Program"] ?? "",
        "PO Number": selected.extra?.["PO Number"] ?? "",
        "PO Amount": selected.extra?.["PO Amount"] ?? "",
      });
      setResults([]);
    }
  }, [selected]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    return EDITABLE_HEADERS.some((h) => (selected.extra?.[h] ?? "") !== values[h]);
  }, [selected, values]);

  async function handleSubmit() {
    if (!selected || !dirty || submitting) return;
    setSubmitting(true);
    setResults([]);
    track("submit_started", { code: selected.code });
    const out: typeof results = [];
    for (const header of EDITABLE_HEADERS) {
      const oldVal = selected.extra?.[header] ?? "";
      if (oldVal === values[header]) continue;
      const column = HEADER_TO_COLUMN[header];
      try {
        const res = await fetchWithRefresh(
          `/api/job-codes/${encodeURIComponent(selected.code)}/cell`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ column, value: values[header] }),
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          detail?: string;
          new_value?: string;
        };
        if (res.ok && body.ok) {
          out.push({ header, ok: true, newValue: body.new_value ?? values[header] });
        } else {
          out.push({ header, ok: false, detail: body.error || `HTTP ${res.status}` });
        }
      } catch (err) {
        out.push({ header, ok: false, detail: (err as Error).message });
      }
    }
    setResults(out);
    setSubmitting(false);
    track("submit_completed", {
      code: selected.code,
      changes: out.length,
      failures: out.filter((o) => !o.ok).length,
    });
    /* Reload so the baseline reflects the new SharePoint state. */
    if (out.some((o) => o.ok)) await loadCatalog();
  }

  return (
    <div
      data-testid="time-log-widget"
      className="mt-2 rounded-md p-3 space-y-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Update a job code
        </div>
        {!canEdit && (
          <span className="text-[10px]" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            (read-only — requires admin role)
          </span>
        )}
      </div>

      {loading && (
        <div data-testid="time-log-loading" className="text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Loading catalog…
        </div>
      )}
      {loadError && !loading && (
        <div
          data-testid="time-log-load-error"
          className="text-xs rounded px-2 py-1"
          style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}
        >
          Couldn&apos;t load codes: {loadError}. Open /job-codes and press Refresh.
        </div>
      )}

      {!loading && !loadError && (
        <>
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              Client / Category
            </label>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setJobCode("");
                track("category_picked", { category: e.target.value });
              }}
              data-testid="time-log-category"
              className="w-full px-2 py-1.5 rounded"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text, #eee)",
                fontSize: "16px",
              }}
            >
              <option value="" disabled>
                Choose a client / category…
              </option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {category && (
            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                Job Code ({filteredCodes.length})
              </label>
              <select
                value={jobCode}
                onChange={(e) => {
                  setJobCode(e.target.value);
                  track("code_picked", { code: e.target.value });
                }}
                data-testid="time-log-code"
                className="w-full px-2 py-1.5 rounded"
                style={{
                  background: "var(--wp-dark, #111)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  color: "var(--wp-text, #eee)",
                  fontSize: "16px",
                }}
              >
                <option value="" disabled>
                  Choose a job code…
                </option>
                {filteredCodes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                    {c.description ? ` — ${c.description}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selected && (
            <>
              {EDITABLE_HEADERS.map((header) => (
                <div key={header}>
                  <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                    {header}
                  </label>
                  <input
                    type="text"
                    value={values[header]}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [header]: e.target.value }))
                    }
                    disabled={!canEdit || submitting}
                    data-testid={`time-log-field-${HEADER_TO_COLUMN[header]}`}
                    placeholder="—"
                    className="w-full px-2 py-1.5 rounded"
                    style={{
                      background: "var(--wp-dark, #111)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      color: "var(--wp-text, #eee)",
                      fontSize: "16px",
                    }}
                  />
                </div>
              ))}

              {results.length > 0 && (
                <ul
                  data-testid="time-log-results"
                  className="space-y-1 text-xs"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  {results.map((r) => (
                    <li
                      key={r.header}
                      data-testid={`time-log-result-${HEADER_TO_COLUMN[r.header]}`}
                      style={{ color: r.ok ? "#4ade80" : "#f87171" }}
                    >
                      {r.ok ? "✓" : "✗"} {r.header}
                      {r.ok ? ` saved (${r.newValue || "—"})` : `: ${r.detail}`}
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    /* Reset back to current SharePoint values. */
                    setValues({
                      "Program": selected.extra?.["Program"] ?? "",
                      "PO Number": selected.extra?.["PO Number"] ?? "",
                      "PO Amount": selected.extra?.["PO Amount"] ?? "",
                    });
                    setResults([]);
                  }}
                  disabled={!dirty || submitting}
                  data-testid="time-log-reset"
                  className="px-3 py-1.5 rounded text-xs"
                  style={{
                    background: "var(--wp-dark, #111)",
                    color: "var(--wp-text-dim, #aaa)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    cursor: dirty && !submitting ? "pointer" : "not-allowed",
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canEdit || !dirty || submitting}
                  data-testid="time-log-submit"
                  className="px-3 py-1.5 rounded text-xs font-medium"
                  style={{
                    background: dirty && canEdit && !submitting ? "var(--wp-gold, #eab308)" : "var(--wp-dark, #111)",
                    color: dirty && canEdit && !submitting ? "var(--wp-dark, #111)" : "var(--wp-text-muted, #6b7280)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    cursor: dirty && canEdit && !submitting ? "pointer" : "not-allowed",
                  }}
                >
                  {submitting ? "Saving…" : "Save to SharePoint"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
