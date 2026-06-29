/**
 * POST /api/admin/users/[id]/capabilities/revoke
 *
 * Body: { capability: string }
 *
 * Requires: `admin.roles.assign`. Removes from grants, appends to revokes.
 * Emits `system.capability_revoked_override`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { isCapability } from "@/lib/auth/capabilities";
import {
  applyRevoke,
  loadUserOverrides,
  emptyOverrides,
  saveUserOverrides,
} from "@/lib/auth/capability-overrides";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "admin.roles.assign");
  if (!auth.ok) return auth.response;

  const { id: targetUserId } = await params;
  const body = (await req.json().catch(() => null)) as
    | { capability?: unknown }
    | null;

  if (!body || !isCapability(body.capability)) {
    return NextResponse.json(
      { error: "invalid_capability" },
      { status: 400 },
    );
  }

  const current = await loadUserOverrides(targetUserId);
  const existing = current?.overrides ?? emptyOverrides();
  const next = applyRevoke(existing, body.capability);

  const persisted = await saveUserOverrides(targetUserId, next);
  if (!persisted && process.env.DATABASE_URL) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  trackEvent(
    "system.capability_revoked_override",
    auth.user.id,
    auth.user.role,
    {
      capability: body.capability,
      revoked_by: auth.user.id,
      user_id: targetUserId,
    },
  );

  // Revoking a capability is a security-relevant authority change: record it to
  // the hash-chained audit log. afterState captures the resulting override set so
  // the entry reflects the change. Best-effort; never breaks the response.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "admin.user.capability_revoked",
    resourceType: "team_member",
    resourceId: targetUserId,
    beforeState: { overrides: existing },
    afterState: { overrides: next, capability: body.capability },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, overrides: next });
}
