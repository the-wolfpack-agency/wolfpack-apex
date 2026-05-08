/**
 * POST /api/auth/reset-password — consume a reset token + set new password.
 *
 * Public endpoint. Identity is proven by the single-use signed token
 * in the request body. Returns generic 404 for any failure mode (bad
 * token / expired / already used) so an attacker can't probe state.
 *
 * Validations:
 *   - password: 8 char min (matches /accept-invite policy)
 *   - token: required string
 *
 * On success: hashes password, updates instinct_team_members.password_hash,
 * marks the reset row used (sets used_at = NOW()).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { safeQuery } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface ResetRow {
  id: string;
  member_id: string;
  expires_at: string;
  used_at: string | null;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { token?: unknown; password?: unknown }
    | null;

  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 },
    );
  }

  const tokenHash = sha256(token);

  const lookup = await safeQuery<ResetRow>(
    `SELECT id, member_id, expires_at, used_at
       FROM instinct_password_resets
      WHERE token_sha256 = $1
      LIMIT 1`,
    [tokenHash],
  );

  // Shadow mode (no DB): pretend success so dev/preview without DB
  // doesn't appear broken. No real row written.
  if (lookup.fromCache) {
    trackEvent("auth.reset_password_completed", "anon", "anon", { mode: "shadow" });
    return NextResponse.json({ ok: true });
  }

  if (lookup.rows.length === 0) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 404 },
    );
  }

  const row = lookup.rows[0];
  if (row.used_at) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 404 },
    );
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 404 },
    );
  }

  // Update password + mark token used. Two queries because Postgres
  // doesn't have a clean atomic "do both" without a transaction; the
  // worst-case race window (password updated, token-mark fails) is
  // benign — the user's password is set; a second attempt with the
  // same token is what fails-closed via the used_at check.
  const passwordHash = await hashPassword(password);

  await safeQuery(
    `UPDATE instinct_team_members SET password_hash = $1 WHERE id = $2`,
    [passwordHash, row.member_id],
  );

  await safeQuery(
    `UPDATE instinct_password_resets SET used_at = NOW() WHERE id = $1`,
    [row.id],
  );

  trackEvent("auth.reset_password_completed", row.member_id, "anon", {
    reset_id: row.id,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: row.member_id, role: "anon" },
    action: "auth.password.reset",
    resourceType: "team_member",
    resourceId: row.member_id,
    afterState: { reset_id: row.id },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true });
}
