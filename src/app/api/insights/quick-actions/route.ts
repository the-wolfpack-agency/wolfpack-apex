/**
 * GET /api/insights/quick-actions
 *
 * Returns the top-4 personalized Quick Actions for the calling user,
 * derived from their last 30 days of `system.page_viewed` events.
 *
 * Cold-start path: when the ranker can't find ≥3 strongly-scored
 * routes, the response is the static fallback so a fresh user sees
 * the same four tiles the dashboard ships with.
 *
 * The ranking algorithm itself lives in `src/lib/insights/quick-actions.ts`
 * — this route is just the auth gate + DB fetch + serializer.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";
import {
  buildQuickActions,
  type PageViewEvent,
  type QuickAction,
} from "@/lib/insights/quick-actions";

interface PageViewRow {
  page: string | null;
  ts: string;
}

export interface QuickActionsResponse {
  actions: QuickAction[];
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 30-day lookback. We pull `metadata->>'page'` directly so the ranker
  // gets `(path, timestamp)` tuples without any other plumbing.
  const result = await safeQuery<PageViewRow>(
    `SELECT metadata->>'page' AS page,
            timestamp::text     AS ts
       FROM instinct_events
      WHERE event_type = 'system.page_viewed'
        AND user_id    = $1
        AND timestamp  > NOW() - INTERVAL '30 days'
      ORDER BY timestamp DESC
      LIMIT 5000`,
    [user.id],
  );

  // DB unreachable / shadow mode → cold-start fallback. Ranker handles
  // an empty event list by returning the static four.
  const events: PageViewEvent[] = result.fromCache
    ? []
    : result.rows
        .filter((r): r is PageViewRow & { page: string } => !!r.page)
        .map((r) => ({ path: r.page, timestamp: r.ts }));

  const actions = buildQuickActions(events);
  const body: QuickActionsResponse = { actions };
  return NextResponse.json(body);
}
