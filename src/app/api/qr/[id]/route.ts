/**
 * /api/qr/[id] — single-code GET / PATCH / DELETE.
 *
 * DELETE is a soft-archive (sets archived_at). The redirect endpoint
 * treats archived codes the same as missing — so a printed billboard
 * can be retired without invalidating the keyspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getCodeById,
  updateCode,
  archiveCode,
} from "@/lib/qr/codes";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const code = await getCodeById(id);
  if (!code) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ code });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  let body: {
    targetUrl?: string;
    label?: string | null;
    utmCampaign?: string | null;
    expiresAt?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  /* Build patch only with fields the caller actually provided so we
     don't accidentally null-out unmodified columns. */
  const patch: Parameters<typeof updateCode>[1] = {};
  if (body.targetUrl !== undefined) patch.targetUrl = body.targetUrl;
  if (body.label !== undefined) patch.label = body.label;
  if (body.utmCampaign !== undefined) patch.utmCampaign = body.utmCampaign;
  if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "patch is empty" }, { status: 400 });
  }

  try {
    const code = await updateCode(id, patch);
    return NextResponse.json({ code });
  } catch (err) {
    const msg = (err as Error).message;
    if (/must use http|must be a valid URL|targetUrl is required/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[api/qr/id] update failed:", msg);
    return NextResponse.json({ error: "Failed to update QR code" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const code = await archiveCode(id);
    return NextResponse.json({ ok: true, code });
  } catch (err) {
    console.error("[api/qr/id] archive failed:", (err as Error).message);
    return NextResponse.json({ error: "Failed to archive QR code" }, { status: 500 });
  }
}
