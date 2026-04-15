/**
 * POST /api/admin/users/[id]/capabilities/grant
 *
 * Body: { capability: string; expiresAt?: string }
 *
 * Requires: `admin.roles.assign`. Appends (idempotently) to the target
 * user's `grants` array. Emits `system.capability_granted_override`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { isCapability } from "@/lib/auth/capabilities";
import {
  applyGrant,
  loadUserOverrides,
  emptyOverrides,
  saveUserOverrides,
} from "@/lib/auth/capability-overrides";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "admin.roles.assign");
  if (!auth.ok) return auth.response;

  const { id: targetUserId } = await params;
  const body = (await req.json().catch(() => null)) as
    | { capability?: unknown; expiresAt?: unknown }
    | null;

  if (!body || !isCapability(body.capability)) {
    return NextResponse.json(
      { error: "invalid_capability" },
      { status: 400 },
    );
  }

  let expiresAt: string | undefined;
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== "string") {
      return NextResponse.json(
        { error: "invalid_expiresAt" },
        { status: 400 },
      );
    }
    const parsed = new Date(body.expiresAt);
    if (!isFinite(parsed.getTime())) {
      return NextResponse.json(
        { error: "invalid_expiresAt" },
        { status: 400 },
      );
    }
    expiresAt = parsed.toISOString();
  }

  const current = await loadUserOverrides(targetUserId);
  const existing = current?.overrides ?? emptyOverrides();
  const next = applyGrant(existing, body.capability, expiresAt);

  const persisted = await saveUserOverrides(targetUserId, next);
  if (!persisted && process.env.DATABASE_URL) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  trackEvent(
    "system.capability_granted_override",
    auth.user.id,
    auth.user.role,
    {
      capability: body.capability,
      granted_by: auth.user.id,
      user_id: targetUserId,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    },
  );

  return NextResponse.json({ ok: true, overrides: next });
}
