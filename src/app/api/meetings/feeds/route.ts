/**
 * GET  /api/meetings/feeds            — list every feed (any meetings.view)
 * POST /api/meetings/feeds            — create a feed (meetings.manage)
 *
 * Capability gating: `meetings.view` for read, `meetings.manage` for
 * write. Mutations fire `meetings.feed_created` analytics; the row
 * itself is the audit ledger (created_by + created_at columns) and
 * the route is allowlisted in AUDIT_ALLOWLIST with the rationale that
 * feed creation isn't HR/finance/auth — it's a workflow config.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { createFeed, listFeeds } from "@/lib/automations/meeting-insights/feeds-repo";
import { validateFeedInput } from "@/lib/automations/meeting-insights/validation";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const onlyEnabled = url.searchParams.get("enabled_only") === "true";

  const feeds = await listFeeds({ onlyEnabled });
  trackEvent("system.page_viewed", auth.user.id, auth.user.role, {
    page: "meeting_feeds_list",
    count: feeds.length,
  });
  return NextResponse.json({ feeds });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.manage");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body must be valid JSON" },
      { status: 400 },
    );
  }

  const validation = validateFeedInput(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_input", detail: validation.error },
      { status: 400 },
    );
  }

  const created = await createFeed({
    input: validation.value,
    created_by: auth.user.email ?? auth.user.id,
  });

  trackEvent("automations.feed_created", auth.user.id, auth.user.role, {
    automation_id: "meeting-insights",
    feed_id: created.id,
    feed_slug: created.slug,
    sender_match_count: created.filters.sender_match.length,
    subject_match_count: created.filters.subject_match.length,
  });

  return NextResponse.json({ feed: created }, { status: 201 });
}
