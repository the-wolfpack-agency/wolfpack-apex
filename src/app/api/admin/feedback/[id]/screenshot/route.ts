/**
 * GET /api/admin/feedback/[id]/screenshot
 *
 * Serves the image a teammate attached to a feedback submission, for the
 * /admin/feedback inbox. Lazy: the list endpoint only returns a
 * has_screenshot flag, and the bytes are fetched here on demand.
 *
 * Capability: settings.manage_team (same gate as the rest of the feedback
 * admin surface). Workspace-scoped: the feedback row must belong to the
 * caller's workspace, otherwise 404 (we do not leak existence across
 * tenants). Returns 404 when the feedback has no screenshot.
 *
 * Security: served with the stored raster content type, nosniff, and a
 * restrictive CSP so the byte stream can never be interpreted as anything
 * but an image. SVG is never stored (see screenshot-store), so there is no
 * inline-script vector here.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";
import { getFeedbackScreenshot } from "@/lib/feedback/screenshot-store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";

  // Confirm the feedback row exists AND belongs to the caller's workspace
  // before serving its image. A cross-tenant id returns 404, same as a
  // missing one, so the endpoint reveals nothing about other workspaces.
  const owner = await query<{ id: string }>(
    `SELECT id FROM instinct_user_feedback
       WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  if (owner.rows.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const shot = await getFeedbackScreenshot(id);
  if (!shot) {
    return NextResponse.json({ error: "no_screenshot" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(shot.dataBase64, "base64");
  } catch {
    return NextResponse.json({ error: "decode_failed" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": shot.contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox",
      // Private: a feedback screenshot is workspace-internal, never shared CDN.
      "Cache-Control": "private, max-age=300",
    },
  });
}
