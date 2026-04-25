/**
 * POST /api/meetings/feeds/[slug]/poll — kick the meeting-insights
 * poller for ONE feed.
 *
 * Auth: `meetings.manage` capability.
 *
 * Implementation note: the underlying Graph delta-feed is
 * automation-scoped, not feed-scoped — there's only one Graph mailbox
 * cursor. Calling /poll on a single feed therefore drains the SAME
 * delta the registry-level poller would, and the per-message router
 * still routes every match to whichever feed wins — but counts
 * returned in the response are filtered to mention only the requested
 * feed when possible. This keeps the "Run now" UX feedback honest.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getAutomation } from "@/lib/automations/registry";
import { pollInboxHistorical, type PollResult } from "@/lib/automations/inbox-poller";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";

interface Ctx {
  params: Promise<{ slug: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.manage");
  if (!auth.ok) return auth.response;
  const { slug } = await ctx.params;

  const feed = await getFeedBySlug(slug);
  if (!feed) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }
  if (!feed.is_enabled) {
    return NextResponse.json(
      { error: "feed_disabled", detail: "enable the feed before polling" },
      { status: 409 },
    );
  }

  const automation = getAutomation("meeting-insights");
  if (!automation) {
    return NextResponse.json(
      { error: "automation_not_registered" },
      { status: 500 },
    );
  }

  try {
    /* "Run now" runs a $search-based historical scan against the
       feed's own filters. Bypasses the shared delta cursor so a brand-
       new feed can pull historical matches; cron continues to drive
       the delta cursor forward for incremental polling. Try userId
       first, fall back to email — same dual-anchor pattern as live-pull. */
    const tryPoll = (key: string) =>
      pollInboxHistorical({
        automationId: "meeting-insights",
        userId: key,
        userRole: auth.user.role,
        filters: {
          sender_match: feed.filters.sender_match ?? [],
          subject_match: feed.filters.subject_match ?? [],
        },
        limit: 50,
      });
    let result: PollResult = await tryPoll(auth.user.id);
    if (
      result.skipped === "no_user_connected" &&
      auth.user.email &&
      auth.user.email !== auth.user.id
    ) {
      result = await tryPoll(auth.user.email);
    }
    trackEvent("automations.feed_poll_triggered", auth.user.id, auth.user.role, {
      automation_id: "meeting-insights",
      feed_id: feed.id,
      feed_slug: feed.slug,
      messages_seen: result.messages_seen,
      messages_matched: result.messages_matched,
      artifacts_ingested: result.artifacts_ingested,
      errors: result.errors,
    });
    return NextResponse.json({ ok: true, feed_slug: feed.slug, result });
  } catch (err) {
    console.error("[meetings/feeds/poll]", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
