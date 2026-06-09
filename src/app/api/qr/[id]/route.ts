/**
 * /api/qr/[id] — single-code GET / PATCH / DELETE.
 *
 * DELETE is a soft-archive (sets archived_at). The redirect endpoint
 * treats archived codes the same as missing — so a printed billboard
 * can be retired without invalidating the keyspace.
 *
 * Deletion-lock (migration 160): a campaign can be `locked` to protect
 * it from an accidental Archive. PATCH { locked } toggles the lock;
 * DELETE refuses with 409 while a campaign is locked — the operator
 * must unlock it first (the deliberate "are you sure?" step). Lock is
 * orthogonal to archived_at: a locked code still redirects.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getCodeById,
  updateCode,
  archiveCode,
  setLocked,
  canArchive,
} from "@/lib/qr/codes";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";

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
    locked?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  /* The lock toggle is its own column (not part of updateCode's content
     patch) so flipping protection never touches the destination URL. */
  if (typeof body.locked === "boolean") {
    try {
      const code = await setLocked(id, body.locked);
      trackEvent(
        body.locked ? "qr.code_locked" : "qr.code_unlocked",
        user.id,
        user.role,
        { code_id: id, slug: code.slug },
      );
      void recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: body.locked ? "qr.code.locked" : "qr.code.unlocked",
        resourceType: "qr_code",
        resourceId: id,
        afterState: { slug: code.slug, locked: code.locked },
      });
      return NextResponse.json({ code });
    } catch (err) {
      console.error("[api/qr/id] lock toggle failed:", (err as Error).message);
      return NextResponse.json(
        { error: "Failed to update QR code" },
        { status: 500 },
      );
    }
  }

  /* Build content patch only with fields the caller actually provided so
     we don't accidentally null-out unmodified columns. */
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

  /* Deletion-lock gate. Refuse to Archive a locked campaign — the
     operator must unlock it first. Enforced on the server so a direct
     API call can't bypass the UI guard. */
  const existing = await getCodeById(id);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!canArchive(existing)) {
    trackEvent("qr.archive_blocked", user.id, user.role, {
      code_id: id,
      slug: existing.slug,
      reason: "locked",
    });
    void recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "qr.code.archive_blocked",
      resourceType: "qr_code",
      resourceId: id,
      afterState: { slug: existing.slug, reason: "locked" },
    });
    return NextResponse.json(
      {
        error: "locked",
        detail:
          "This campaign is locked. Unlock it first to archive — this protects an active code from accidental removal.",
      },
      { status: 409 },
    );
  }

  try {
    const code = await archiveCode(id);
    void recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "qr.code.archived",
      resourceType: "qr_code",
      resourceId: id,
      beforeState: { slug: existing.slug, archivedAt: existing.archivedAt },
      afterState: { slug: code.slug, archivedAt: code.archivedAt },
    });
    return NextResponse.json({ ok: true, code });
  } catch (err) {
    console.error("[api/qr/id] archive failed:", (err as Error).message);
    return NextResponse.json({ error: "Failed to archive QR code" }, { status: 500 });
  }
}
