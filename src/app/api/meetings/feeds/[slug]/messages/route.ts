/**
 * GET /api/meetings/feeds/[slug]/messages — recent messages for a feed.
 *
 * `meetings.view` required. Returns the most-recent N messages
 * (default 50, max 200) ordered by received_at desc.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";
import { listMessagesForFeed } from "@/lib/automations/meeting-insights/messages-repo";

interface Ctx {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { slug } = await ctx.params;

  const feed = await getFeedBySlug(slug);
  if (!feed) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "50", 10) || 50, 1),
    200,
  );

  const messages = await listMessagesForFeed({ feed_id: feed.id, limit });
  trackEvent("system.page_viewed", auth.user.id, auth.user.role, {
    page: "meeting_feed_messages",
    feed_id: feed.id,
    feed_slug: feed.slug,
    count: messages.length,
  });
  return NextResponse.json({ feed, messages });
}
