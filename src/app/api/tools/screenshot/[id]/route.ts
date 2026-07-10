/**
 * GET /api/tools/screenshot/[id]
 *
 * Serves a captured screenshot's PNG bytes, workspace-scoped. This is the
 * `imageUrl` the agent-run task step renders as a thumbnail. Mirrors the
 * feedback-screenshot serving route: capability-gated, cross-tenant ids 404
 * (no existence leak), and served with nosniff + a restrictive CSP so the byte
 * stream can only ever be an image. Only PNG is stored, so no inline-script
 * vector exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getScreenshot } from "@/lib/tools/screenshot/store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";
  const shot = await getScreenshot(id, workspaceId);
  if (!shot) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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
      "Cache-Control": "private, max-age=300",
    },
  });
}
