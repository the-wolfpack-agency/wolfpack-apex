"use client";

/**
 * /admin/time — Hoxsie-grade team-wide time breakdown.
 *
 * Window picker (7d / 30d / 90d), summary chips, per-user totals,
 * per-job-code totals, and a full grid pivot of user × job_code.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Bucket {
  user_id: string;
  user_email: string | null;
  user_role: string | null;
  job_code: string;
  total_hours: number;
  entry_count: number;
}

interface PerUser {
  user_id: string;
  user_email: string | null;
  total_hours: number;
  entry_count: number;
}

interface PerJob {
  job_code: string;
  total_hours: number;
  entry_count: number;
  contributor_count: number;
}

interface SummaryResponse {
  summary: {
    total_hours: number;
    entry_count: number;
    contributor_count: number;
    job_code_count: number;
    since: string;
    until: string | null;
  };
  buckets: Bucket[];
  per_user: PerUser[];
  per_job: PerJob[];
  fetched_at: string;
}

const WINDOWS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export default function AdminTimePage() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const res = await fetchWithRefresh(`/api/admin/time-summary?since=${since}`);
      if (!res.ok) {
        if (res.status === 403) setError("You don't have permission to view team time.");
        else setError(`Could not load (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as SummaryResponse;
      setData(body);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Build a user × job_code pivot for the grid view. */
  const pivot = (() => {
    if (!data) return { rows: [] as PerUser[], cols: [] as string[], cells: new Map<string, number>() };
    const cells = new Map<string, number>();
    for (const b of data.buckets) cells.set(`${b.user_id}::${b.job_code}`, b.total_hours);
    return {
      rows: data.per_user,
      cols: data.per_job.map((j) => j.job_code),
      cells,
    };
  })();

  return (
    <div
      data-testid="admin-time-page"
      style={{ padding: "2rem 1.5rem", maxWidth: "1100px", margin: "0 auto", color: "var(--wp-text, #eee)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>Team time</h1>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              data-testid={`admin-time-window-${w.label}`}
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
        Hours logged by the team. Click a window above to change range.
      </p>

      {error && <div data-testid="admin-time-error" style={{ padding: "0.75rem 1rem", background: "rgba(239,68,68,0.08)", color: "var(--wp-error, #ef4444)", border: "1px solid var(--wp-error, #ef4444)", borderRadius: "6px", marginBottom: "1rem" }}>{error}</div>}
      {loading && !data && <div style={{ color: "var(--wp-text-muted, #6b7280)" }}>Loading…</div>}

      {data && (
        <>
          <div data-testid="admin-time-summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem", marginBottom: "1.5rem" }}>
            <Stat label="Total hours" value={data.summary.total_hours.toFixed(2)} highlight />
            <Stat label="Entries" value={String(data.summary.entry_count)} />
            <Stat label="Contributors" value={String(data.summary.contributor_count)} />
            <Stat label="Job codes" value={String(data.summary.job_code_count)} />
          </div>

          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>By person</h2>
          {data.per_user.length === 0 ? (
            <div data-testid="admin-time-no-people" style={{ padding: "1rem", color: "var(--wp-text-muted, #6b7280)" }}>No entries.</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1.5rem 0" }} data-testid="admin-time-per-user">
              {data.per_user.map((u) => (
                <li
                  key={u.user_id}
                  data-testid={`admin-time-user-${u.user_id}`}
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.5rem 0.9rem", marginBottom: "0.3rem", background: "var(--wp-dark-surface, #1f1f22)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "6px" }}
                >
                  <span style={{ fontSize: "0.85rem" }}>{u.user_email ?? u.user_id}</span>
                  <span style={{ fontSize: "0.85rem", color: "var(--wp-gold, #f1c233)" }}>{u.total_hours.toFixed(2)}h · {u.entry_count} entries</span>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>By job code</h2>
          {data.per_job.length === 0 ? (
            <div style={{ padding: "1rem", color: "var(--wp-text-muted, #6b7280)" }}>No entries.</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1.5rem 0" }} data-testid="admin-time-per-job">
              {data.per_job.map((j) => (
                <li
                  key={j.job_code}
                  data-testid={`admin-time-job-${j.job_code}`}
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.5rem 0.9rem", marginBottom: "0.3rem", background: "var(--wp-dark-surface, #1f1f22)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "6px" }}
                >
                  <span style={{ fontSize: "0.85rem" }}>{j.job_code}</span>
                  <span style={{ fontSize: "0.85rem", color: "var(--wp-gold, #f1c233)" }}>{j.total_hours.toFixed(2)}h · {j.contributor_count} {j.contributor_count === 1 ? "person" : "people"}</span>
                </li>
              ))}
            </ul>
          )}

          {pivot.rows.length > 0 && pivot.cols.length > 0 && (
            <>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>Pivot — person × job code</h2>
              <div style={{ overflowX: "auto", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "6px" }}>
                <table data-testid="admin-time-pivot" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
                      <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid var(--wp-dark-border, #333)" }}>Person</th>
                      {pivot.cols.map((c) => (
                        <th key={c} style={{ textAlign: "right", padding: "0.5rem", borderBottom: "1px solid var(--wp-dark-border, #333)" }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pivot.rows.map((u) => (
                      <tr key={u.user_id}>
                        <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--wp-dark-border, #333)" }}>{u.user_email ?? u.user_id}</td>
                        {pivot.cols.map((c) => {
                          const h = pivot.cells.get(`${u.user_id}::${c}`);
                          return (
                            <td key={c} style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid var(--wp-dark-border, #333)", color: h ? "var(--wp-text, #eee)" : "var(--wp-text-muted, #6b7280)" }}>
                              {h ? h.toFixed(2) : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ padding: "0.75rem 1rem", background: "var(--wp-dark-surface, #1f1f22)", border: `1px solid ${highlight ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`, borderRadius: "8px" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600, color: highlight ? "var(--wp-gold, #f1c233)" : "var(--wp-text, #eee)", marginTop: "0.2rem" }}>{value}</div>
    </div>
  );
}
