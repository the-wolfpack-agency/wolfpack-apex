/**
 * PATCH /api/admin/users/[id]/name
 *
 * Body: { name: string }
 *
 * Requires: `settings.manage_team`. Mirrors the /role endpoint pattern.
 * Shipped 2026-05-20 to scrub leftover "TEST" display names from the
 * pre-fix accept-invite flow without needing a one-shot SQL script.
 *
 * Validation:
 *   - Trims whitespace.
 *   - 1-120 chars (matches the old accept-invite maxLength).
 *   - No path-traversal or HTML — name is used in plain-text email
 *     greetings and audit-log entries, never sourced from URLs.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery, query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const NAME_MAX = 120;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id: targetUserId } = await params;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const raw = typeof body?.name === "string" ? body.name.trim() : "";
  if (!raw || raw.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name must be 1-${NAME_MAX} characters` },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    trackEvent("system.team_member_renamed", auth.user.id, auth.user.role, {
      user_id: targetUserId,
      to_name: raw,
      mode: "shadow",
    });
    return NextResponse.json({ ok: true, name: raw, shadow: true });
  }

  const { rows } = await safeQuery<{ name: string | null }>(
    `SELECT name FROM instinct_team_members WHERE id = $1 AND is_active = true`,
    [targetUserId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  const fromName = rows[0].name ?? "";

  const result = await query(
    `UPDATE instinct_team_members SET name = $2 WHERE id = $1 AND is_active = true`,
    [targetUserId, raw],
  );
  if ((result.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  trackEvent("system.team_member_renamed", auth.user.id, auth.user.role, {
    user_id: targetUserId,
    from_name: fromName,
    to_name: raw,
    changed_by: auth.user.id,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "team.member.renamed",
    resourceType: "team_member",
    resourceId: targetUserId,
    beforeState: { name: fromName },
    afterState: { name: raw },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, from_name: fromName, to_name: raw });
}
