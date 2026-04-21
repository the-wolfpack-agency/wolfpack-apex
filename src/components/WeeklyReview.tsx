"use client";

import React, { useEffect, useState, useCallback } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

/**
 * Weekly Review card — Mon→Sun retrospective with slip detector.
 *
 * Self-fetches the current week on mount via `fetchWithRefresh`
 * (mandatory per CLAUDE.md — no raw fetch in authenticated client
 * components).
 *
 * Fires `review.weekly_viewed` once on successful load with metadata
 * the learning loop uses to slice engagement by week.
 *
 * Each slip has a "Resolve" button that PATCHes /api/tasks/:id with
 * `status: "inProgress"` and fires `review.slip_resolved`.
 */

interface Slip {
  id: string;
  title: string;
  reason: "overdue" | "carried_forward";
  dueAt: string | null;
}

interface WeeklyReviewData {
  weekStart: string;
  weekEnd: string;
  meetingsAttended: number;
  tasksClosed: number;
  tasksOpened: number;
  unansweredFlagged: number;
  slips: Slip[];
}

function postAnalytics(event: string, metadata: Record<string, string | number | boolean>): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {});
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function reasonLabel(reason: Slip["reason"]): string {
  return reason === "overdue" ? "Overdue" : "Carried forward";
}

export default function WeeklyReview() {
  const [data, setData] = useState<WeeklyReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolvedIds, setResolvedIds] = useState<Record<string, true>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/review/weekly", {
        headers: jsonHeaders(),
      });
      if (!res.ok) {
        setError(`Failed to load weekly review (${res.status})`);
        return;
      }
      const body: WeeklyReviewData = await res.json();
      setData(body);
      setError(null);
      postAnalytics("review.weekly_viewed", {
        week_start: body.weekStart,
        slip_count: body.slips.length,
        meetings_attended: body.meetingsAttended,
        tasks_closed: body.tasksClosed,
      });
    } catch {
      setError("Failed to load weekly review");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onResolve(slip: Slip): Promise<void> {
    if (resolving[slip.id] || resolvedIds[slip.id]) return;
    setResolving((s) => ({ ...s, [slip.id]: true }));
    try {
      const res = await fetchWithRefresh(`/api/tasks/${encodeURIComponent(slip.id)}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ status: "inProgress" }),
      });
      if (res.ok) {
        setResolvedIds((r) => ({ ...r, [slip.id]: true }));
        postAnalytics("review.slip_resolved", {
          week_start: data?.weekStart ?? "",
          task_id: slip.id,
          reason: slip.reason,
        });
      }
    } finally {
      setResolving((s) => {
        const { [slip.id]: _ignored, ...rest } = s;
        void _ignored;
        return rest;
      });
    }
  }

  if (error) {
    return (
      <div
        data-testid="weekly-review-error"
        role="alert"
        style={{
          padding: "1rem 1.25rem",
          background: "rgba(239, 68, 68, 0.08)",
          border: "1px solid var(--wp-error, rgba(239,68,68,0.35))",
          borderRadius: 10,
          color: "var(--wp-text)",
        }}
      >
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div
        data-testid="weekly-review-loading"
        style={{
          padding: "1rem 1.25rem",
          background: "var(--wp-dark-surface, rgba(0,0,0,0.2))",
          border: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
          borderRadius: 10,
          color: "var(--wp-text-dim, #888)",
        }}
      >
        Loading weekly review…
      </div>
    );
  }

  return (
    <section
      data-testid="weekly-review"
      style={{
        padding: "1.25rem 1.5rem",
        background: "var(--wp-dark-surface, rgba(0,0,0,0.2))",
        border: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
        borderRadius: 12,
        color: "var(--wp-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, color: "var(--wp-gold, #d4af37)" }}>
          Weekly Review
        </h2>
        <div
          data-testid="weekly-review-range"
          style={{ fontSize: 12, color: "var(--wp-text-dim, #888)" }}
        >
          {formatDate(data.weekStart)} – {formatDate(
            new Date(new Date(data.weekEnd).getTime() - 1).toISOString(),
          )}
        </div>
      </header>

      <dl
        data-testid="weekly-review-counts"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 12,
          margin: "1rem 0",
        }}
      >
        <Metric label="Meetings" value={data.meetingsAttended} testId="weekly-review-meetings" />
        <Metric label="Tasks closed" value={data.tasksClosed} testId="weekly-review-closed" />
        <Metric label="Tasks opened" value={data.tasksOpened} testId="weekly-review-opened" />
        <Metric
          label="Unanswered flagged"
          value={data.unansweredFlagged}
          testId="weekly-review-unanswered"
        />
      </dl>

      <section data-testid="weekly-review-slips">
        <h3 style={{ margin: "0 0 0.5rem", fontSize: 14, color: "var(--wp-text)" }}>
          Slipped tasks ({data.slips.length})
        </h3>
        {data.slips.length === 0 ? (
          <p
            data-testid="weekly-review-slips-empty"
            style={{ margin: 0, color: "var(--wp-text-dim, #888)", fontSize: 13 }}
          >
            Nothing slipped this week.
          </p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {data.slips.map((slip) => {
              const isResolved = resolvedIds[slip.id] === true;
              const isBusy = resolving[slip.id] === true;
              return (
                <li
                  key={slip.id}
                  data-testid={`weekly-review-slip-${slip.id}`}
                  style={{
                    padding: "0.5rem 0.75rem",
                    border: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
                    borderRadius: 8,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--wp-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {slip.title}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--wp-text-dim, #888)" }}>
                      {reasonLabel(slip.reason)}
                      {slip.dueAt ? ` • due ${formatDate(slip.dueAt)}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid={`weekly-review-resolve-${slip.id}`}
                    onClick={() => onResolve(slip)}
                    disabled={isBusy || isResolved}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--wp-border, rgba(255,255,255,0.15))",
                      background: isResolved
                        ? "var(--wp-success, rgba(34,197,94,0.2))"
                        : "transparent",
                      color: "var(--wp-text)",
                      cursor: isBusy || isResolved ? "default" : "pointer",
                    }}
                  >
                    {isResolved ? "Resolved" : isBusy ? "…" : "Resolve"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}

function Metric({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}): React.JSX.Element {
  return (
    <div data-testid={testId}>
      <dt style={{ fontSize: 11, color: "var(--wp-text-dim, #888)", textTransform: "uppercase" }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 22, color: "var(--wp-text)", fontWeight: 600 }}>
        {value}
      </dd>
    </div>
  );
}
