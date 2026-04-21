import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  fetchCalendarEvents,
  fetchRecentEmails,
} from "@/lib/microsoft-graph";
import { listCachedTasks } from "@/lib/integrations/microsoft-tasks";
import { computeInsights, sortBySeverity } from "@/lib/ms-insights/insights";

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
  // fetchCalendarEvents caps at $top=50 ordered by start/dateTime ASC,
  // so a wide window on a busy calendar returns only the OLDEST 50 and
  // buries today. Keep the window narrow (yesterday → +3 days).
  const startIso = new Date(nowMs - 1 * dayMs).toISOString();
  const endIso = new Date(nowMs + 3 * dayMs).toISOString();

  const [events, emails, tasksPage] = await Promise.all([
    fetchCalendarEvents(user.id, startIso, endIso).catch(() => []),
    fetchRecentEmails(user.id, 25).catch(() => []),
    listCachedTasks(user.id, { limit: 200 }).catch(() => ({ tasks: [], total: 0 })),
  ]);

  const insights = sortBySeverity(
    computeInsights({
      events,
      emails,
      tasks: tasksPage.tasks ?? [],
      nowMs,
      lookbackDays: 7,
    }),
  );

  trackEvent("ms_insight.computed", user.id, user.role, {
    insight_count: insights.length,
    risk_count: insights.filter((i) => i.severity === "risk").length,
    warn_count: insights.filter((i) => i.severity === "warn").length,
  });

  return NextResponse.json({ insights });
}
