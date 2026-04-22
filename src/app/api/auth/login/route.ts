import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { issueRefreshToken } from "@/lib/crypto/refresh-tokens";
import {
  setAuthCookie,
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/crypto/cookies";

// Rate limit: lenient by design so a legitimate user mistyping their
// password on shared Wi-Fi (client site, co-working space) isn't locked
// out of every account on that IP. 20 attempts per IP per 60 seconds,
// and the counter is cleared on any successful login so one good auth
// resets the slate — devastating scenarios like "I need to log in right
// now to help a client" stay recoverable.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 20;
const WINDOW_MS = 60 * 1000;

function isRateLimited(ip: string): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { limited: false, retryAfter: 0 };
  }
  entry.count++;
  if (entry.count > MAX_ATTEMPTS) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

function clearRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const { limited, retryAfter } = isRateLimited(ip);
  if (limited) {
    trackEvent("system.login_rate_limited", "anonymous", "unknown", { ip });
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const body = await req.json();
  const { email, password } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const meta = extractRequestMetadata(req);
  const result = await authenticate(email, password);

  if (!result) {
    // Audit failed login (no user id — use email identifier instead)
    await recordAudit({
      actor: { user_id: `email:${email}`, role: "anonymous" },
      action: "auth.login.failed",
      resourceType: "auth_session",
      resourceId: email,
      afterState: { email },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((err) => console.warn("[audit]", (err as Error).message));
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Successful login clears the rate-limit slate for this IP so one
  // correct auth recovers the user from any prior mistyped attempts.
  clearRateLimit(ip);

  await recordAudit({
    actor: { user_id: result.user.id, role: result.user.role },
    action: "auth.login.succeeded",
    resourceType: "auth_session",
    resourceId: result.user.id,
    afterState: { email: result.user.email, role: result.user.role },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((err) => console.warn("[audit]", (err as Error).message));

  // Issue refresh token (requires DB; silently skipped in shadow/dev mode without DATABASE_URL)
  let refreshTokenId: string | undefined;
  if (process.env.DATABASE_URL) {
    try {
      const rt = await issueRefreshToken(result.user.id);
      refreshTokenId = rt.tokenId;
    } catch (err) {
      console.warn("[auth/login] Could not issue refresh token:", (err as Error).message);
    }
  }

  const res = NextResponse.json({
    user: result.user,
    // Keep token in body for backward-compat with existing clients using
    // localStorage (client-auth.ts). Will be removed once all clients migrate to cookies.
    token: result.token,
  });

  // Set access token as HttpOnly cookie (15 min)
  setAuthCookie(res, ACCESS_TOKEN_COOKIE, result.token, ACCESS_TOKEN_TTL, {
    sameSite: "Lax",
  });

  // Set refresh token as HttpOnly cookie with Strict SameSite (7 days)
  if (refreshTokenId) {
    setAuthCookie(res, REFRESH_TOKEN_COOKIE, refreshTokenId, REFRESH_TOKEN_TTL_SECONDS, {
      sameSite: "Strict",
    });
  }

  return res;
}

// Exported for testing
export { loginAttempts, MAX_ATTEMPTS, WINDOW_MS };
