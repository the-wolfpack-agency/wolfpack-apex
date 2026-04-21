"use client";

/**
 * /goals — ONE shared goals board.
 *
 * No "my goals" vs "team goals" split: one OKR set, one contribution
 * stream, one weekly commitments sidebar. Every teammate sees the same
 * page; the sidebar scopes only the user's own bets + grading buttons.
 *
 * Data sources (read-through offline cache):
 *   - /api/goals                       → active OKRs + latest North Star
 *   - /api/goals/weekly/:week_of       → team commitments this week
 *
 * Writes (offline-queue):
 *   - POST /api/goals/contributions    via sendCommitmentOffline
 *   - PATCH /api/goals/contributions/:id/grade via sendGradeOffline
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh, getInstinctToken, getInstinctUser } from "@/lib/client-auth";
import { useOfflineCache } from "@/lib/hooks/useOfflineCache";
import NorthStarTile from "@/components/goals/NorthStarTile";
import OkrCard from "@/components/goals/OkrCard";
import CommitmentsSidebar from "@/components/goals/CommitmentsSidebar";
import FridaySyncView from "@/components/goals/FridaySyncView";
import {
  krList,
  type ContributionView,
  type KrView,
  type NorthStarView,
  type OkrView,
} from "@/components/goals/types";

interface GoalsResponse {
  okrs: OkrView[];
  north_star: NorthStarView;
}

interface WeeklyResponse {
  week_of: string;
  commitments: ContributionView[];
}

interface ContributionsByKrResponse {
  contributions: ContributionView[];
}

function todayWeekOfMonday(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const offset = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export default function GoalsPage() {
  const [userId, setUserId] = useState<string>("");
  const [userRole, setUserRole] = useState<string>("");
  // Streams are fetched per-KR when the OKR is expanded. Kept in local
  // state rather than cached per-KR because the stream list is small
  // and the offline layer already covers OKRs + weekly.
  const [streamsByKr, setStreamsByKr] = useState<Record<string, ContributionView[]>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  const week_of = useMemo(todayWeekOfMonday, []);

  useEffect(() => {
    const token = getInstinctToken();
    if (!token) {
      if (typeof window !== "undefined") {
        window.location.href = "/login?next=/goals";
      }
      return;
    }
    const u = getInstinctUser<{ id: string; role: string }>();
    if (u) {
      setUserId(u.id);
      setUserRole(u.role);
    }
    // Fire view analytics (mirrors how /dashboard does it).
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "goal.page_viewed",
        metadata: { page: "goals" },
      }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const goalsFetcher = useCallback(async (): Promise<GoalsResponse> => {
    const res = await fetchWithRefresh("/api/goals");
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

  const okrs = goals.data?.okrs ?? [];
  const northStar = goals.data?.north_star?.latest ?? null;
  const northStarHistory = goals.data?.north_star?.history ?? [];
  const teamCommitments = weekly.data?.commitments ?? [];

  const allKrs: KrView[] = useMemo(
    () => okrs.flatMap((o) => krList(o)),
    [okrs],
  );

  const myCommitments = useMemo(
    () => teamCommitments.filter((c) => c.user_id === userId),
    [teamCommitments, userId],
  );

  // Load 7-day streams for KRs as their parent OKR expands. We fetch
  // everything up-front because the payload is small (≤ a few dozen
  // rows per KR) and the offline cache layer already handles failure
  // gracefully.
  useEffect(() => {
    if (okrs.length === 0) return;
    const seven = new Date();
    seven.setDate(seven.getDate() - 7);
    const since = seven.toISOString();

    allKrs.forEach((kr) => {
      if (streamsByKr[kr.id] !== undefined) return;
      void (async () => {
        try {
          const res = await fetchWithRefresh(
            `/api/goals/contributions?kr_id=${encodeURIComponent(kr.id)}&since=${encodeURIComponent(since)}`,
          );
          if (!res.ok) {
            setStreamsByKr((s) => ({ ...s, [kr.id]: [] }));
            return;
          }
          const data = (await res.json()) as ContributionsByKrResponse;
          setStreamsByKr((s) => ({ ...s, [kr.id]: data.contributions ?? [] }));
        } catch {
          setStreamsByKr((s) => ({ ...s, [kr.id]: [] }));
        }
      })();
    });
    // NOTE: allKrs identity changes only when okrs change, so this
    // effect does not loop; streamsByKr is intentionally excluded from
    // deps to avoid a refetch storm on setState.

  }, [allKrs]);

  // Populate userNames so contribution streams show real names. Best-
  // effort — on failure we fall back to showing the raw user_id.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWithRefresh("/api/team");
        if (!res.ok) return;
        const data = (await res.json()) as {
          members?: Array<{ id: string; name: string }>;
        };
        const map: Record<string, string> = {};
        for (const m of data.members ?? []) map[m.id] = m.name;
        setUserNames(map);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function handleOptimisticAdd(row: ContributionView) {
    const injected: ContributionView = { ...row, user_id: userId };
    weekly.data && (weekly.data.commitments = [...teamCommitments, injected]);
    // Also inject into the matching KR stream so the board surfaces the
    // new commit immediately.
    setStreamsByKr((s) => ({
      ...s,
      [row.kr_id]: [injected, ...(s[row.kr_id] ?? [])],
    }));
  }

  function handleOptimisticGrade(
    id: string,
    grade: ContributionView["graded_as"],
  ) {
    if (!weekly.data) return;
    weekly.data.commitments = weekly.data.commitments.map((c) =>
      c.id === id ? { ...c, graded_as: grade } : c,
    );
    setStreamsByKr((s) => {
      const next: typeof s = { ...s };
      for (const k of Object.keys(next)) {
        next[k] = next[k].map((c) => (c.id === id ? { ...c, graded_as: grade } : c));
      }
      return next;
    });
  }

  return (
    <div
      className="max-w-6xl mx-auto space-y-6"
      data-testid="goals-page"
      data-user-role={userRole}
    >
      <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
        Goals
      </h1>

      {/* North Star — top-center */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-start-2">
          <NorthStarTile
            label={northStar?.label ?? null}
            value={northStar?.value ?? null}
            unit={northStar?.unit ?? null}
            history={northStarHistory}
          />
        </div>
      </div>

      {goals.isStale && (
        <div
          className="rounded-lg border p-3 text-xs"
          style={{
            background: "var(--wp-warning)10",
            borderColor: "var(--wp-warning)40",
            color: "var(--wp-warning)",
          }}
          data-testid="goals-stale-banner"
        >
          Offline — showing cached goals.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* OKR cards stack (2/3) */}
        <div className="lg:col-span-2 space-y-3">
          {goals.isLoading ? (
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              Loading goals…
            </p>
          ) : okrs.length === 0 ? (
            <div
              className="rounded-lg border p-6 text-center"
              style={{
                background: "var(--wp-dark-surface)",
                borderColor: "var(--wp-dark-border)",
              }}
            >
              <p style={{ color: "var(--wp-text-muted)" }}>
                No active OKRs yet. Admins can seed them via the API.
              </p>
            </div>
          ) : (
            okrs.map((okr, i) => (
              <OkrCard
                key={okr.id}
                okr={okr}
                streams={streamsByKr}
                userNames={userNames}
                defaultOpen={i === 0}
              />
            ))
          )}
        </div>

        {/* Sidebar (1/3) */}
        <div className="space-y-4">
          <CommitmentsSidebar
            week_of={week_of}
            krs={allKrs}
            myCommitments={myCommitments}
            onOptimisticAdd={handleOptimisticAdd}
            onOptimisticGrade={handleOptimisticGrade}
          />
        </div>
      </div>

      <FridaySyncView
        week_of={week_of}
        teamCommitments={teamCommitments}
        userNames={userNames}
      />
    </div>
  );
}
