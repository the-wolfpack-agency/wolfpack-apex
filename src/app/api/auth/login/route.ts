import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";

// Rate limit: 5 attempts per IP per 5 minutes
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;

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

  const result = await authenticate(email, password);

  if (!result) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  return NextResponse.json({
    user: result.user,
    token: result.token,
  });
}

// Exported for testing
export { loginAttempts, MAX_ATTEMPTS, WINDOW_MS };
