/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId] — single message
 * with attachment metadata.
 *
 * Capability: `meetings.view`. Attachment bytes are NOT returned here;
 * download requires `meetings.export` and goes via the dedicated
 * download route (Stream B owns the body of that route).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";
import {
  getMessage,
  listAttachmentsForMessage,
} from "@/lib/automations/meeting-insights/messages-repo";

interface Ctx {
  params: Promise<{ slug: string; messageId: string }>;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { slug, messageId } = await ctx.params;

  const feed = await getFeedBySlug(slug);
  if (!feed) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }

  const message = await getMessage({ feed_id: feed.id, message_id: messageId });
  if (!message) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  const attachments = await listAttachmentsForMessage(message.id);

  trackEvent("system.page_viewed", auth.user.id, auth.user.role, {
    page: "meeting_message_detail",
    feed_id: feed.id,
    message_id: message.id,
  });

  return NextResponse.json({ feed, message, attachments });
}
