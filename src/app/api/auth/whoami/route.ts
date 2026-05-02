/**
 * GET /api/auth/whoami
 *
 * Bridges HttpOnly auth cookie → client-side localStorage. The
 * Microsoft sign-in callback sets the access-token cookie (HttpOnly)
 * + a refresh-token cookie, but `src/lib/client-auth.ts` reads from
 * localStorage. Without bridging the two, every authenticated fetch
 * from a client component returns 401 because the Bearer header is
 * missing.
 *
 * The login page calls this on `?ms=connected` and persists the
 * returned (token, user) pair via setInstinctSession so the rest of
 * the app behaves identically to a password login.
 *
 * Returns 401 when no valid access-token cookie is present.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { ACCESS_TOKEN_COOKIE } from "@/lib/crypto/cookies";

export async function GET(_req: NextRequest) {
  const jar = await cookies();
  const cookieToken = jar.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!cookieToken) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }
  try {
    const payload = verifyToken(cookieToken);
    return NextResponse.json({
      token: cookieToken,
      user: {
        id: payload.userId,
        email: payload.email,
        name: payload.name,
        role: payload.role,
      },
    });
  } catch {
    return NextResponse.json({ error: "invalid_session" }, { status: 401 });
  }
}
