/**
 * GET /api/meetings/brief?title=...&start=...&attendee=...&attendee=...
 *
 * Phase 4 — Calendar event brief. Returns the rolling brief composed
 * by `assembleBrief` for the most-specific feed whose subject_match
 * substring is contained in the event title. 200 with `null` body
 * when nothing matches; the caller renders an empty state.
 *
 * Auth: meetings.view (read-only — no audit, but still analytics
 * tracked because the event title is sensitive enough to want a
 * record of who looked at which brief).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { assembleBrief } from "@/lib/automations/meeting-insights/brief";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const title = (url.searchParams.get("title") ?? "").trim();
  const start = (url.searchParams.get("start") ?? "").trim();
  const attendees = url.searchParams.getAll("attendee");

  if (!title) {
    return NextResponse.json(
      { error: "invalid_input", detail: "title is required" },
      { status: 400 },
    );
  }

  const brief = await assembleBrief(title, start, attendees);

  trackEvent("meeting_insights.brief_viewed", auth.user.id, auth.user.role, {
    title,
    matched: brief !== null,
    feed_slug: brief?.feed.slug ?? "",
    open_action_items: brief?.open_action_items.length ?? 0,
    recurring_topics: brief?.recurring_topics.length ?? 0,
    exception_count: brief?.exception_count ?? 0,
  });

  return NextResponse.json({ brief });
}
