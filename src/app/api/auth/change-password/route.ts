/**
 * POST /api/auth/change-password
 *
 * Auth-required. Caller submits { current_password, new_password }
 * and we replace their stored bcrypt hash after verifying the
 * current one matches. Used by the Settings page for "change my
 * password" without going through the forgot-password email loop.
 *
 * Shipped 2026-05-20 after a teammate (Ashley) was told to "change
 * password from Settings" but no such surface existed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hashPassword, verifyPassword } from "@/lib/auth";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const MIN_LEN = 8;

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    current_password?: string;
    new_password?: string;
  } | null;
  if (!body || typeof body.current_password !== "string" || typeof body.new_password !== "string") {
    return NextResponse.json(
      { error: "current_password and new_password are required" },
      { status: 400 },
    );
  }
  if (body.new_password.length < MIN_LEN) {
    return NextResponse.json(
      { error: `new_password must be at least ${MIN_LEN} characters` },
      { status: 400 },
    );
  }
  if (body.new_password === body.current_password) {
    return NextResponse.json(
      { error: "new password must differ from current password" },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    /* Shadow mode — pretend it worked so local/test paths don't break. */
    trackEvent("system.password_changed", user.id, user.role, { mode: "shadow" });
    return NextResponse.json({ ok: true, shadow: true });
  }

  let stored: { password_hash: string | null } | null = null;
  try {
    const res = await query<{ password_hash: string | null }>(
      `SELECT password_hash FROM instinct_team_members
       WHERE id = $1 AND is_active = true LIMIT 1`,
      [user.id],
    );
    stored = res.rows[0] ?? null;
  } catch (err) {
    console.error("[change-password] lookup failed:", (err as Error).message);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!stored?.password_hash) {
    return NextResponse.json(
      { error: "no current password on file; use Forgot password instead" },
      { status: 409 },
    );
  }
  if (!verifyPassword(body.current_password, stored.password_hash)) {
    trackEvent("system.password_change_failed", user.id, user.role, { reason: "wrong_current" });
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  const newHash = hashPassword(body.new_password);
  try {
    await query(
      `UPDATE instinct_team_members SET password_hash = $1 WHERE id = $2`,
      [newHash, user.id],
    );
  } catch (err) {
    console.error("[change-password] update failed:", (err as Error).message);
    return NextResponse.json({ error: "could_not_update" }, { status: 500 });
  }

  trackEvent("system.password_changed", user.id, user.role, { method: "self_service" });

  /* Credential change is a security-relevant event, so hash-chain it. The
     password material is never recorded; only the actor + that a change
     occurred. recordAudit is best-effort and must not fail the request. */
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "auth.password_changed",
      resourceType: "team_member",
      resourceId: user.id,
      afterState: { method: "self_service" },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[change-password audit]", (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}
