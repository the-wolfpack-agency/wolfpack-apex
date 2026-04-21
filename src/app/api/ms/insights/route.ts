import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  fetchCalendarEvents,
  fetchRecentEmails,
} from "@/lib/microsoft-graph";
import { listCachedTasks } from "@/lib/integrations/microsoft-tasks";
import { computeInsights, sortBySeverity } from "@/lib/ms-insights/insights";
import { ingestInsightsToBrain } from "@/lib/brain/ingest-insights";

/**
 * GET /api/ms/insights
 *
 * Composes calendar + recent emails + cached tasks, runs the
 * side-effect-free insight computers, returns a sorted list. Each
 * insight is stable by `id` so the learning loop can count
 * views/dismissals per pattern.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60_000;
  // fetchCalendarEvents caps at $top=50 ordered by start/dateTime ASC
  // per call, so we fan out into narrow windows that each stay under
  // the cap, then merge. Covers -7d → +3d which is what the insights
  // (meeting_load, focus_time, recurring_attendees) actually need.
  const windows: Array<[string, string]> = [
    [new Date(nowMs - 7 * dayMs).toISOString(), new Date(nowMs - 4 * dayMs).toISOString()],
    [new Date(nowMs - 4 * dayMs).toISOString(), new Date(nowMs - 1 * dayMs).toISOString()],
    [new Date(nowMs - 1 * dayMs).toISOString(), new Date(nowMs + 3 * dayMs).toISOString()],
  ];

  const [eventBatches, emails, tasksPage] = await Promise.all([
    Promise.all(
      windows.map(([s, e]) => fetchCalendarEvents(user.id, s, e).catch(() => [])),
    ),
    fetchRecentEmails(user.id, 25).catch(() => []),
    listCachedTasks(user.id, { limit: 200 }).catch(() => ({ tasks: [], total: 0 })),
  ]);

  // Dedupe across windows (calendarview may re-emit events that straddle
  // boundaries, especially recurring series).
  const seen = new Set<string>();
  const events = eventBatches.flat().filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  const insights = sortBySeverity(
    computeInsights({
      events,
      emails,
      tasks: tasksPage.tasks ?? [],
      nowMs,
      lookbackDays: 7,
      selfTokens: [user.name, user.email].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      ),
    }),
  );

  trackEvent("ms_insight.computed", user.id, user.role, {
    insight_count: insights.length,
    risk_count: insights.filter((i) => i.severity === "risk").length,
    warn_count: insights.filter((i) => i.severity === "warn").length,
  });

  // Fire-and-forget Brain write so insight snapshots feed into the
  // central RAG store alongside uploaded docs and discussions.
  void ingestInsightsToBrain(user.id, user.role, insights, nowMs);

  return NextResponse.json({ insights });
}
