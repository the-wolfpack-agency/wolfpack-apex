/**
 * GET /api/meetings/feeds/[slug]/search?q=...
 *
 * Free-text search across the analyses of one feed. Capability:
 * `meetings.view`. q is required; q.length <= 200; we cap result set
 * at 5 by default (UI-tunable up to 20).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";
import { semanticSearch } from "@/lib/automations/meeting-insights/themes";

interface Ctx {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { slug } = await ctx.params;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.max(1, Math.min(parseInt(limitRaw ?? "5", 10) || 5, 20));

  if (!q) {
    return NextResponse.json(
      { error: "missing_query", detail: "q parameter is required" },
      { status: 400 },
    );
  }
  if (q.length > 200) {
    return NextResponse.json(
      { error: "query_too_long", detail: "q must be ≤ 200 characters" },
      { status: 400 },
    );
  }

  const feed = await getFeedBySlug(slug);
  if (!feed) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }

  const hits = await semanticSearch({
    feed_id: feed.id,
    query: q,
    limit,
  });

  trackEvent("automations.themes_searched", auth.user.id, auth.user.role, {
    automation_id: "meeting-insights",
    feed_id: feed.id,
    feed_slug: feed.slug,
    query_length: q.length,
    hit_count: hits.length,
  });

  return NextResponse.json({ feed, query: q, hits });
}
