"use client";

/**
 * TimeLogWidget — inline assistant form to log hours against a job
 * code. Triggered by the `log_time` tool ("log time", "track time",
 * "log hours"). Persists via POST /api/time-entries.
 *
 * Minimal-friction: job code free-text (autocompletes from the
 * user's recent codes), hours stepped at 0.25, date defaults to
 * today with one-tap Yesterday option, optional notes.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface RecentEntry {
  id: string;
  job_code: string;
  hours: number;
  logged_for_date: string;
  notes: string | null;
}

interface CatalogCode {
  code: string;
  description: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface TimeLogWidgetProps {
  workflowId?: string;
}

export function TimeLogWidget({ workflowId }: TimeLogWidgetProps) {
  const [jobCode, setJobCode] = useState("");
  const [hours, setHours] = useState("1");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(todayIso());
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogCode[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const loadRecent = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const res = await fetchWithRefresh(`/api/time-entries?since=${since}&limit=20`);
      if (!res.ok) return;
      const body = (await res.json()) as { entries?: RecentEntry[] };
      setRecent(body.entries ?? []);
    } catch {
      /* silent — recent codes are a nice-to-have */
    }
  }, []);

  /* Pull the canonical job code catalog from the SharePoint-backed
     /api/job-codes endpoint. Failure is silent — recent codes + manual
     typing both still work. This swaps the previous free-text guess for
     a real autocomplete grounded in the workbook owners control. */
  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/job-codes");
      if (!res.ok) return;
      const body = (await res.json()) as { codes?: Array<{ code: string; description: string }> };
      setCatalog(
        (body.codes ?? []).map((c) => ({ code: c.code, description: c.description })),
      );
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void loadRecent();
    void loadCatalog();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: { widget_kind: "time_log", ...(workflowId ? { workflow_id: workflowId } : {}) },
      }),
    }).catch(() => undefined);
  }, [workflowId, loadRecent, loadCatalog]);

  /* Autocomplete suggestions — filter the catalog by the current input
     (case-insensitive match on code OR description). Capped at 8 so the
     dropdown stays compact under the assistant input. */
  const suggestions = (() => {
    const q = jobCode.trim().toLowerCase();
    if (!q) return [];
    return catalog
      .filter(
        (c) =>
          c.code.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      )
      .slice(0, 8);
  })();

  /* Job-code chips: top 5 most-frequent codes from the user's last
     14 days, so re-logging the same one is a single tap. */
  const recentCodes = (() => {
    const counts = new Map<string, number>();
    for (const r of recent) counts.set(r.job_code, (counts.get(r.job_code) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
  })();

  async function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setError(null);
    setSuccessId(null);
    if (!jobCode.trim()) {
      setError("Job code is required.");
      return;
    }
    const hoursNum = Number(hours);
    if (!Number.isFinite(hoursNum) || hoursNum <= 0 || hoursNum > 24) {
      setError("Hours must be between 0 and 24.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithRefresh("/api/time-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_code: jobCode,
          hours: hoursNum,
          notes: notes.trim() || undefined,
          logged_for_date: date,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; entry?: { id: string }; error?: string };
      if (!res.ok || !body.ok || !body.entry) {
        setError(body.error || `Could not log time (HTTP ${res.status})`);
        return;
      }
      setSuccessId(body.entry.id);
      setNotes("");
      setHours("1");
      // Keep jobCode + date so the user can log multiple back-to-back entries fast.
      void loadRecent();
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="time-log-widget"
      className="mt-2 rounded-md p-3 space-y-2"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="text-sm font-semibold" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        Log time
      </div>

      <form onSubmit={submit} className="space-y-2">
        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            Job code
          </label>
          <div className="relative">
            <input
              type="text"
              value={jobCode}
              onChange={(e) => {
                setJobCode(e.target.value.toUpperCase());
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => {
                /* tiny delay so a suggestion click registers before
                   the input loses focus and the dropdown closes. */
                window.setTimeout(() => setShowSuggestions(false), 120);
              }}
              placeholder="Start typing — codes from the SharePoint workbook"
              data-testid="time-log-jobcode"
              autoComplete="off"
              className="w-full px-2 py-1.5 rounded"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text, #eee)",
                fontSize: "16px",
              }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <ul
                data-testid="time-log-suggestions"
                className="absolute z-10 left-0 right-0 mt-1 rounded max-h-56 overflow-y-auto"
                style={{
                  background: "var(--wp-dark-surface2, #1a1a1a)",
                  border: "1px solid var(--wp-dark-border, #333)",
                }}
              >
                {suggestions.map((s) => (
                  <li key={s.code}>
                    <button
                      type="button"
                      data-testid={`time-log-suggestion-${s.code}`}
                      onMouseDown={(e) => {
                        /* mousedown fires before blur, so we can set
                           the value and close the menu without losing
                           the click. */
                        e.preventDefault();
                        setJobCode(s.code);
                        setShowSuggestions(false);
                      }}
                      className="w-full text-left px-2 py-1.5 text-xs"
                      style={{ color: "var(--wp-text, #eee)", background: "transparent", border: "none", cursor: "pointer" }}
                    >
                      <span className="font-mono">{s.code}</span>
                      {s.description && (
                        <span className="ml-2" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                          — {s.description}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {recentCodes.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {recentCodes.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setJobCode(c)}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{
                    background: jobCode === c ? "var(--wp-gold, #eab308)" : "var(--wp-dark, #111)",
                    color: jobCode === c ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
                    border: "1px solid var(--wp-dark-border, #333)",
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              Hours
            </label>
            <input
              type="number"
              step="0.25"
              min="0"
              max="24"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              data-testid="time-log-hours"
              className="w-full px-2 py-1.5 rounded"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text, #eee)",
                fontSize: "16px",
              }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              Date
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="time-log-date"
              className="w-full px-2 py-1.5 rounded"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text, #eee)",
                fontSize: "16px",
              }}
            />
            <div className="flex gap-1 mt-1">
              <button type="button" onClick={() => setDate(todayIso())} className="text-[10px] underline" style={{ color: "var(--wp-text-muted, #6b7280)", background: "transparent", border: "none" }}>Today</button>
              <button type="button" onClick={() => setDate(yesterdayIso())} className="text-[10px] underline" style={{ color: "var(--wp-text-muted, #6b7280)", background: "transparent", border: "none" }}>Yesterday</button>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was done? (≤500 chars)"
            data-testid="time-log-notes"
            rows={2}
            className="w-full px-2 py-1.5 rounded resize-y"
            style={{
              background: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-dark-border, #333)",
              color: "var(--wp-text, #eee)",
              fontSize: "16px",
              minHeight: "44px",
            }}
          />
        </div>

        {error && (
          <div
            data-testid="time-log-error"
            className="rounded px-2 py-1 text-xs"
            style={{
              background: "rgba(239, 68, 68, 0.1)",
              color: "var(--wp-error, #ef4444)",
              border: "1px solid var(--wp-error, #ef4444)",
            }}
          >
            {error}
          </div>
        )}

        {successId && (
          <div
            data-testid="time-log-success"
            className="rounded px-2 py-1 text-xs"
            style={{
              background: "rgba(74, 222, 128, 0.1)",
              color: "#4ade80",
              border: "1px solid #4ade80",
            }}
          >
            Logged. #{successId.slice(0, 8)}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting || !jobCode.trim()}
            data-testid="time-log-submit"
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: submitting || !jobCode.trim() ? "var(--wp-dark, #111)" : "var(--wp-gold, #eab308)",
              color: submitting || !jobCode.trim() ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
              cursor: submitting || !jobCode.trim() ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Logging…" : "Log time"}
          </button>
        </div>
      </form>
    </div>
  );
}
