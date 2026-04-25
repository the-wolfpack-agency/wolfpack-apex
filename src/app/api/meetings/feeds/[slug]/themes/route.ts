/**
 * GET /api/meetings/feeds/[slug]/themes
 *
 * Returns the cross-meeting theme tracker payload:
 *   - recurring topics
 *   - stale topics
 *   - open action items
 *
 * Capability: `meetings.view`. Read-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";
import {
  recurringTopics,
  staleTopics,
  openActionItems,
} from "@/lib/automations/meeting-insights/themes";

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

  const [recurring, stale, actions] = await Promise.all([
    recurringTopics({ feed_id: feed.id }),
    staleTopics({ feed_id: feed.id }),
    openActionItems({ feed_id: feed.id }),
  ]);

  trackEvent("automations.themes_viewed", auth.user.id, auth.user.role, {
    automation_id: "meeting-insights",
    feed_id: feed.id,
    feed_slug: feed.slug,
    recurring: recurring.length,
    stale: stale.length,
    open_action_items: actions.length,
  });

  return NextResponse.json({
    feed,
    recurring,
    stale,
    action_items: actions,
  });
}
