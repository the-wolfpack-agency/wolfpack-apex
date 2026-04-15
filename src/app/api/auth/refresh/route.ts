/**
 * POST /api/auth/refresh
 *
 * Rotate a refresh token:
 *   - Validate the incoming refresh token (from HttpOnly cookie or body).
 *   - Mark the old token used.
 *   - Issue a new access token (15 min) + new refresh token (7 days).
 *   - Re-use of a revoked token revokes the entire family (theft detection).
 *
 * Returns both tokens as HttpOnly cookies. No sensitive material in JSON body.
 */

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createToken } from "@/lib/auth";
import { rotateRefreshToken } from "@/lib/crypto/refresh-tokens";
import {
  setAuthCookie,
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/crypto/cookies";
import { trackEvent } from "@/lib/analytics";
import type { TeamMember, TeamRole } from "@/lib/auth";

export async function POST(req: NextRequest) {
  // Accept refresh token from HttpOnly cookie (preferred) or JSON body (fallback for API clients)
  const cookieToken = req.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  let bodyToken: string | undefined;

  try {
    const body = (await req.json().catch(() => ({}))) as { refresh_token?: string };
    bodyToken = body.refresh_token;
  } catch {
    // body parse failure is fine — we may use the cookie
  }

  const tokenId = cookieToken ?? bodyToken;

  if (!tokenId) {
    return NextResponse.json({ error: "Refresh token required" }, { status: 400 });
  }

  try {
    const rotated = await rotateRefreshToken(tokenId);

    // Load the user from the database to reconstruct the member object
    let user: TeamMember | null = null;

    if (process.env.DATABASE_URL) {
      const result = await query(
        `SELECT id, email, name, role, avatar_url, created_at
         FROM apex_team_members
         WHERE id = $1 AND is_active = true`,
        [rotated.userId],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        user = {
          id: row.id as string,
          email: row.email as string,
          name: row.name as string,
          role: row.role as TeamRole,
          avatar_url: row.avatar_url as string | undefined,
          created_at: row.created_at as string,
        };
      }
    }

    if (!user) {
      // Shadow/dev mode: reconstruct minimal user from userId
      user = {
        id: rotated.userId,
        email: "",
        name: "",
        role: "dev",
        created_at: new Date().toISOString(),
      };
    }

    const accessToken = createToken(user);

    const res = NextResponse.json({ ok: true });

    setAuthCookie(res, ACCESS_TOKEN_COOKIE, accessToken, ACCESS_TOKEN_TTL, {
      sameSite: "Lax",
    });
    setAuthCookie(res, REFRESH_TOKEN_COOKIE, rotated.tokenId, REFRESH_TOKEN_TTL_SECONDS, {
      sameSite: "Strict",
    });

    trackEvent("system.token_signed", user.id, user.role, {
      algorithm: "hs256",
      quantum_safe: false,
      ttl_seconds: ACCESS_TOKEN_TTL,
    });

    return res;
  } catch (err) {
    const reason = (err as Error).message;

    if (reason === "refresh_token_reused") {
      return NextResponse.json({ error: "Token reuse detected — session revoked" }, { status: 401 });
    }
    if (reason === "refresh_token_expired") {
      return NextResponse.json({ error: "Refresh token expired" }, { status: 401 });
    }
    if (reason === "refresh_token_revoked") {
      return NextResponse.json({ error: "Refresh token revoked" }, { status: 401 });
    }
    if (reason === "refresh_token_not_found") {
      return NextResponse.json({ error: "Invalid refresh token" }, { status: 401 });
    }

    console.error("[auth/refresh] Unexpected error:", reason);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
