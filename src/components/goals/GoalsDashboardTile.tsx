"use client";

/**
 * GoalsDashboardTile — compact tile pinned to the main dashboard page.
 *
 * Shows:
 *   - Latest North Star value + trend sparkline
 *   - Count of this-week commitments across the team (+ pending)
 *   - Click-through link to /goals
 *
 * Offline: uses `useOfflineCache` so the tile survives a cold-load.
 */

import { useCallback } from "react";
import Link from "next/link";
import NorthStarTile from "./NorthStarTile";
import { useOfflineCache } from "@/lib/hooks/useOfflineCache";
import { fetchWithRefresh } from "@/lib/client-auth";

interface GoalsResponse {
  okrs: unknown[];
  north_star: {
    latest: {
      label: string;
      value: number;
      unit: string | null;
      captured_at: string;
    } | null;
    history: Array<{ value: number; captured_at: string }>;
  };
}

interface WeeklyResponse {
  week_of: string;
  commitments: Array<{ graded_as: string | null }>;
}

function todayWeekOfMonday(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const offset = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export default function GoalsDashboardTile() {
  const week_of = todayWeekOfMonday();

  const goalsFetcher = useCallback(async (): Promise<GoalsResponse> => {
    const res = await fetchWithRefresh("/api/goals?north_star_limit=14");
    if (!res.ok) throw new Error(`goals_${res.status}`);
    return (await res.json()) as GoalsResponse;
  }, []);

  const weeklyFetcher = useCallback(async (): Promise<WeeklyResponse> => {
    const res = await fetchWithRefresh(`/api/goals/weekly/${week_of}`);
    if (!res.ok) throw new Error(`weekly_${res.status}`);
    return (await res.json()) as WeeklyResponse;
  }, [week_of]);

  const goals = useOfflineCache<GoalsResponse>("goals_summary", "v1", goalsFetcher);
  const weekly = useOfflineCache<WeeklyResponse>(
    "goals_weekly",
    week_of,
    weeklyFetcher,
  );

  const latest = goals.data?.north_star?.latest ?? null;
  const history = goals.data?.north_star?.history ?? [];

  const commitments = weekly.data?.commitments ?? [];
  const totalCommits = commitments.length;
  const pending = commitments.filter((c) => c.graded_as == null).length;

  return (
    <Link
      href="/goals"
      data-testid="goals-dashboard-tile"
      onClick={() => {
        void fetchWithRefresh("/api/analytics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "goal.page_viewed",
            metadata: { page: "dashboard_tile" },
          }),
          keepalive: true,
        }).catch(() => {});
      }}
      className="block rounded-lg border p-4 transition-colors hover:border-[var(--wp-gold)]"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide" style={{ color: "var(--wp-text-muted)" }}>
          Goals
        </h3>
        {goals.isStale && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "var(--wp-warning)20", color: "var(--wp-warning)" }}
            data-testid="goals-tile-stale"
          >
            offline
          </span>
        )}
      </div>
      <div className="mt-2">
        <NorthStarTile
          label={latest?.label ?? null}
          value={latest?.value ?? null}
          unit={latest?.unit ?? null}
          history={history}
          compact
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span style={{ color: "var(--wp-text-dim)" }}>This week</span>
        <span style={{ color: "var(--wp-text)" }}>
          {totalCommits} commits · {pending} pending
        </span>
      </div>
    </Link>
  );
}
