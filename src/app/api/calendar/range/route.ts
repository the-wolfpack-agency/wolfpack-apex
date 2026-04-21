/**
 * GET /api/calendar/range?view=week|month|year&ref=<iso>
 *
 * Returns { events, insights, suggestions } for the requested range.
 * The /calendar page uses this for every view tab + trend panel.
 *
 * Fires calendar.range_computed so the learning loop can correlate
 * which views the user actually engages with vs ignores. The computed
 * snapshot is also fire-and-forget written into the Brain (RAG store)
 * so the assistant can later recall "what did my calendar look like
 * in April 2026."
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { fetchCalendarEvents } from "@/lib/microsoft-graph";
import {
  computeHistoricalInsights,
  rangeBoundsFor,
  type RangeView,
} from "@/lib/calendar/historical-insights";
import { generateCalendarSuggestions } from "@/lib/calendar/suggestions";
import { ingestCalendarRangeToBrain } from "@/lib/brain/ingest-insights";

const MS_DAY = 24 * 60 * 60_000;

function parseView(raw: string | null): RangeView {
  if (raw === "month" || raw === "year") return raw;
  return "week";
}

function parseRef(raw: string | null): number {
  if (!raw) return Date.now();
  const t = Date.parse(raw);
  return Number.isNaN(t) ? Date.now() : t;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const url = new URL(req.url);
  const view = parseView(url.searchParams.get("view"));
  const refMs = parseRef(url.searchParams.get("ref"));

  const { startMs, endMs } = rangeBoundsFor(view, refMs);

  // Fan the Graph fetch into ≤4-day slices so no single call hits
  // the $top=50 cap. Works for weeks (single slice), months (~8),
  // and years (~90).
  const slices: Array<[string, string]> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(cursor + 4 * MS_DAY, endMs);
    slices.push([new Date(cursor).toISOString(), new Date(next).toISOString()]);
    cursor = next;
  }
  const batches = await Promise.all(
    slices.map(([s, e]) => fetchCalendarEvents(user.id, s, e).catch(() => [])),
  );
  const seen = new Set<string>();
  const events = batches.flat().filter((ev) => {
    if (seen.has(ev.id)) return false;
    seen.add(ev.id);
    return true;
  });

  const insights = computeHistoricalInsights({
    events,
    rangeStartMs: startMs,
    rangeEndMs: endMs,
    selfTokens: [user.name, user.email].filter((x): x is string => typeof x === "string" && x.length > 0),
  });
  const suggestions = generateCalendarSuggestions({ insights, view });

  trackEvent("calendar.range_computed", user.id, user.role, {
    view,
    event_count: insights.meetingCount,
    suggestion_count: suggestions.length,
    risk_suggestions: suggestions.filter((s) => s.severity === "act").length,
  });

  // Fire-and-forget Brain write — assistant can later query "how was
  // my April calendar?" and get this snapshot from RAG.
  void ingestCalendarRangeToBrain(user.id, user.role, {
    view,
    startMs,
    endMs,
    insights,
    suggestions,
  });

  return NextResponse.json({
    view,
    range: { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() },
    events,
    insights,
    suggestions,
  });
}
