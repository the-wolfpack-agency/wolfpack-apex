/**
 * GET    /api/meetings/feeds/[slug]   — fetch one feed (meetings.view)
 * PUT    /api/meetings/feeds/[slug]   — patch (meetings.manage)
 * DELETE /api/meetings/feeds/[slug]   — soft-delete (meetings.manage)
 *
 * The DELETE flips is_enabled=false rather than removing the row;
 * preserving message history is required by the spec. Hard-delete is
 * intentionally not exposed.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  disableFeed,
  getFeedBySlug,
  updateFeed,
} from "@/lib/automations/meeting-insights/feeds-repo";
import { validateFeedPatch } from "@/lib/automations/meeting-insights/validation";

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
  trackEvent("system.page_viewed", auth.user.id, auth.user.role, {
    page: "meeting_feed_detail",
    feed_id: feed.id,
    feed_slug: feed.slug,
  });
  return NextResponse.json({ feed });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.manage");
  if (!auth.ok) return auth.response;
  const { slug } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      { status: 400 },
    );
  }

  const validation = validateFeedPatch(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_input", detail: validation.error },
      { status: 400 },
    );
  }

  const updated = await updateFeed({ slug, patch: validation.value });
  if (!updated) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }

  trackEvent("automations.feed_updated", auth.user.id, auth.user.role, {
    automation_id: "meeting-insights",
    feed_id: updated.id,
    feed_slug: updated.slug,
    fields: Object.keys(validation.value).sort().join(","),
  });

  return NextResponse.json({ feed: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.manage");
  if (!auth.ok) return auth.response;
  const { slug } = await ctx.params;

  const updated = await disableFeed(slug);
  if (!updated) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }

  trackEvent("automations.feed_disabled", auth.user.id, auth.user.role, {
    automation_id: "meeting-insights",
    feed_id: updated.id,
    feed_slug: updated.slug,
  });

  return NextResponse.json({ feed: updated });
}
