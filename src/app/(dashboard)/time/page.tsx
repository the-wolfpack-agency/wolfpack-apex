"use client";

/**
 * /time — personal time-entry history. Lists the user's own entries
 * for the selected window (default: last 7 days). Used to verify
 * "did I log that" without opening the assistant again.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { TimeLogWidget } from "@/components/widgets/TimeLogWidget";

interface TimeEntry {
  id: string;
  job_code: string;
  hours: number;
  notes: string | null;
  logged_for_date: string;
  created_at: string;
}

function relativeDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export default function TimePage() {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const res = await fetchWithRefresh(`/api/time-entries?since=${since}&limit=500`);
      if (!res.ok) {
        setError(`Could not load entries (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as { entries?: TimeEntry[] };
      setEntries(body.entries ?? []);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Group entries by logged_for_date for the "Today / Yesterday / …"
     rollup, AND compute totals by job_code over the window. */
  const grouped = new Map<string, TimeEntry[]>();
  const totalsByJobCode = new Map<string, number>();
  let totalHours = 0;
  for (const e of entries) {
    if (!grouped.has(e.logged_for_date)) grouped.set(e.logged_for_date, []);
    grouped.get(e.logged_for_date)!.push(e);
    totalsByJobCode.set(e.job_code, (totalsByJobCode.get(e.job_code) ?? 0) + e.hours);
    totalHours += e.hours;
  }
  const totalsRanked = [...totalsByJobCode.entries()].sort((a, b) => b[1] - a[1]);
  const dateBuckets = [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  return (
    <div
      data-testid="time-page"
      style={{ padding: "2rem 1.5rem", maxWidth: "920px", margin: "0 auto", color: "var(--wp-text, #eee)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>My time</h1>
        <div style={{ display: "flex", gap: "0.4rem" }} data-testid="time-window-picker">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              data-testid={`time-window-${w.label}`}
              style={{
                padding: "0.3rem 0.7rem",
                fontSize: "0.8rem",
                borderRadius: "6px",
                cursor: "pointer",
                background: days === w.days ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-surface2, #1a1a1a)",
                color: days === w.days ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
                border: `1px solid ${days === w.days ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0 0 1.5rem 0", fontSize: "0.9rem" }}>
        Log hours below. Hoxsie sees the team rollup at <code>/admin/time</code>.
      </p>

      <TimeLogWidget />

      <h2 style={{ fontSize: "1rem", margin: "1.5rem 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>
        Totals · last {days}d
      </h2>
      {totalsRanked.length === 0 ? (
        <div data-testid="time-totals-empty" style={{ padding: "0.75rem 1rem", color: "var(--wp-text-muted, #6b7280)" }}>
          No entries in window.
        </div>
      ) : (
        <div data-testid="time-totals" style={{ marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)", marginBottom: "0.5rem" }}>
            <strong style={{ color: "var(--wp-gold, #f1c233)" }}>{totalHours.toFixed(2)}h</strong> total · {entries.length} entries
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {totalsRanked.map(([code, hrs]) => (
              <li
                key={code}
                style={{ display: "flex", justifyContent: "space-between", padding: "0.4rem 0", borderBottom: "1px solid var(--wp-dark-border, #333)" }}
              >
                <span style={{ fontSize: "0.85rem" }}>{code}</span>
                <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>{hrs.toFixed(2)}h</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2 style={{ fontSize: "1rem", margin: "1.5rem 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>Entries</h2>
      {error && (
        <div data-testid="time-page-error" style={{ padding: "0.75rem 1rem", background: "rgba(239,68,68,0.08)", color: "var(--wp-error, #ef4444)", border: "1px solid var(--wp-error, #ef4444)", borderRadius: "6px" }}>
          {error}
        </div>
      )}
      {loading && entries.length === 0 && <div style={{ color: "var(--wp-text-muted, #6b7280)" }}>Loading…</div>}
      {!loading && entries.length === 0 && !error && (
        <div data-testid="time-entries-empty" style={{ padding: "1rem", color: "var(--wp-text-muted, #6b7280)" }}>
          No entries yet. Log one above.
        </div>
      )}

      {dateBuckets.map(([date, dayEntries]) => {
        const dayTotal = dayEntries.reduce((s, e) => s + e.hours, 0);
        return (
          <div key={date} data-testid={`time-day-${date}`} style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
              <strong>{relativeDate(date)}</strong>
              <span>{dayTotal.toFixed(2)}h</span>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {dayEntries.map((e) => (
                <li
                  key={e.id}
                  data-testid={`time-entry-${e.id}`}
                  style={{ padding: "0.6rem 0.9rem", marginBottom: "0.3rem", background: "var(--wp-dark-surface, #1f1f22)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "0.5rem" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>{e.job_code}</div>
                    {e.notes && <div style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)", marginTop: "0.2rem", wordBreak: "break-word" }}>{e.notes}</div>}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--wp-gold, #f1c233)", whiteSpace: "nowrap" }}>{Number(e.hours).toFixed(2)}h</div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
