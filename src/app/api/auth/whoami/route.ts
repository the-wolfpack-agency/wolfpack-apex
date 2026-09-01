/**
 * GET /api/auth/whoami
 *
 * Bridges HttpOnly auth cookie → client-side localStorage. Two roles:
 *
 * 1. Microsoft sign-in flow: the callback sets the access-token cookie
 *    but doesn't write to localStorage. The dashboard layout calls
 *    /whoami on mount to hydrate the client-side session.
 *
 * 2. Stale-user-id self-heal. Migration 128 deduplicated
 *    instinct_team_members by email and deleted non-canonical rows.
 *    Sessions minted before that migration carry the deleted user id
 *    in their JWT; every authenticated read returns no data because
 *    observations etc. now live under the canonical id. /whoami
 *    detects this case (token's userId not found in team-members),
 *    looks up the canonical row by email, and re-mints the JWT under
 *    the canonical id. Refreshes both the cookie and the localStorage
 *    bridge in one round trip — no manual sign-out required.
 *
 * Returns 401 when no valid access-token cookie is present OR the
 * email also isn't in team-members (genuinely deactivated user).
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createToken, verifyToken, DEFAULT_WORKSPACE_ID, type TeamRole } from "@/lib/auth";
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL,
  setAuthCookie,
} from "@/lib/crypto/cookies";
import { safeQuery } from "@/lib/db";

export async function GET(_req: NextRequest) {
  const jar = await cookies();
  const cookieToken = jar.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!cookieToken) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }
  let payload: ReturnType<typeof verifyToken>;
  try {
    payload = verifyToken(cookieToken);
  } catch {
    return NextResponse.json({ error: "invalid_session" }, { status: 401 });
  }

  /* Verify the token's userId still exists in instinct_team_members.
     If it does, return the current token unchanged. If it doesn't,
     fall through to the self-heal path. */
  let stillExists = false;
  try {
    const r = await safeQuery<{ id: string }>(
      `SELECT id FROM instinct_team_members WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [payload.userId],
    );
    stillExists = r.rows.length > 0;
  } catch {
    /* DB unreachable → trust the JWT (shadow-mode behavior). */
    stillExists = true;
  }

  if (stillExists) {
    return NextResponse.json({
      token: cookieToken,
      user: {
        id: payload.userId,
        email: payload.email,
        name: payload.name,
        role: payload.role,
      },
    });
  }

  /* Self-heal: look up canonical row by email, mint a fresh JWT under
     the canonical id, and replace the cookie. */
  const lookup = await safeQuery<{
    id: string;
    email: string;
    name: string;
    role: string;
    workspace_id: string | null;
  }>(
    `SELECT id, email, name, role, workspace_id FROM instinct_team_members
      WHERE LOWER(email) = LOWER($1) AND is_active = TRUE LIMIT 1`,
    [payload.email],
  );
  const row = lookup.rows[0];
  if (!row) {
    /* Token's email isn't in the active team — deactivated. Hard 401. */
    return NextResponse.json({ error: "user_not_active" }, { status: 401 });
  }

  const member = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as TeamRole,
    workspaceId: row.workspace_id ?? DEFAULT_WORKSPACE_ID,
    created_at: "",
  };
  const newToken = createToken(member);
  const res = NextResponse.json({ token: newToken, user: member });
  setAuthCookie(res, ACCESS_TOKEN_COOKIE, newToken, ACCESS_TOKEN_TTL, {
    sameSite: "Lax",
  });
  return res;
}
