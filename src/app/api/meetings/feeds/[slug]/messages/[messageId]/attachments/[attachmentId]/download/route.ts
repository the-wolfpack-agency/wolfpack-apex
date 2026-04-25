/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/download
 *
 * Streams the raw attachment bytes back to the browser. Phase 1 reads
 * directly from the bytea column (Stream A's schema). Phase 2 will move
 * bytes to object storage; this route is the stable URL contract either
 * way.
 *
 * Capability: `meetings.export` — only roles that can pull raw bytes
 * out of the system. The lighter `meetings.view` capability suffices
 * for the parsed-text route; downloading the raw file is a separate
 * step.
 *
 * 401 unauth, 403 forbidden, 404 not-found. On success, the response
 * sets `Content-Type` to the attachment's stored mime and
 * `Content-Disposition: attachment; filename="..."` so the browser
 * triggers a save dialog.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getAttachmentForServe } from "@/lib/automations/meeting-insights/attachment-store";

/**
 * Quote a filename for use in Content-Disposition. We escape only the
 * characters that break the header — quote and backslash — and strip
 * CR/LF outright (header injection guard).
 */
function quoteFilename(name: string): string {
  return name
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

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
  const auth = await requireCapability(req, "meetings.export");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { slug, messageId, attachmentId } = await params;

  const attachment = await getAttachmentForServe(slug, messageId, attachmentId);
  if (!attachment || !attachment.bytes) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  trackEvent("meeting_insights.attachment_downloaded", user.id, user.role, {
    feed_slug: slug,
    message_id: messageId,
    attachment_id: attachmentId,
    filename: attachment.filename,
    mime: attachment.mime,
    size_bytes: attachment.size_bytes,
  });

  // Buffer → Uint8Array — NextResponse accepts BodyInit; Buffer is one
  // but TS's lib.dom typings sometimes drop it, so we coerce.
  const body = new Uint8Array(attachment.bytes);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": attachment.mime || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${quoteFilename(attachment.filename)}"`,
      "Content-Length": String(attachment.size_bytes),
      // Prevent browser from caching potentially sensitive bytes.
      "Cache-Control": "private, no-store",
    },
  });
}
