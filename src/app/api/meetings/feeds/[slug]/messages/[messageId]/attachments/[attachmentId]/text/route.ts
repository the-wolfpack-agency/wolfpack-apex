/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/text
 *
 * Returns the parsed plain text for one attachment as JSON. The
 * AttachmentBlock UI hits this route on first expand so users can read
 * an extracted .docx / .pdf / .html / .txt without downloading the
 * raw file (which would require the heavier `meetings.export`
 * capability).
 *
 * Response shape — matches what AttachmentBlock expects:
 *
 *     {
 *       text: string | null,
 *       status: "extracted" | "unsupported_mime" | "error",
 *       filename: string,
 *       mime: string,
 *       size_bytes: number
 *     }
 *
 * Capability: `meetings.view` (read-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getAttachmentForServe } from "@/lib/automations/meeting-insights/attachment-store";

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      messageId: string;
      attachmentId: string;
    }>;
  },
) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { slug, messageId, attachmentId } = await params;

  const attachment = await getAttachmentForServe(slug, messageId, attachmentId);
  if (!attachment) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  trackEvent("meeting_insights.attachment_text_viewed", user.id, user.role, {
    feed_slug: slug,
    message_id: messageId,
    attachment_id: attachmentId,
    extraction_status: attachment.extraction_status,
    mime: attachment.mime,
  });

  return NextResponse.json({
    text: attachment.extracted_text,
    status: attachment.extraction_status,
    filename: attachment.filename,
    mime: attachment.mime,
    size_bytes: attachment.size_bytes,
  });
}
