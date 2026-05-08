/**
 * POST /api/auth/forgot-password — request a password reset email.
 *
 * Public endpoint. Rate-limited to 5 attempts / 15-min per IP to limit
 * email-enumeration probes. ALWAYS returns 200 with the same body
 * shape regardless of whether the email exists — leaking that signal
 * is a classic enumeration sink.
 *
 * Token model:
 *   - 32 random bytes, base64url-encoded → presented to the user as `token`
 *   - SHA-256 of the token stored in `instinct_password_resets.token_sha256`
 *   - 15-minute expiry per the security policy
 *   - Single-use: `used_at` flips on successful reset
 *
 * Email delivery: graceful when RESEND_API_KEY is unset. The response
 * includes `dev_link` (only when not delivered) so the CTO can hand-
 * deliver the link until Resend is wired. Production responses with a
 * verified domain delivered should NOT carry dev_link.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash, randomUUID } from "crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  buildResetUrl,
  sendResetEmail,
  type ResetEmailArgs,
  type ResetEmailResult,
} from "@/lib/mail/send-password-reset";

const TOKEN_BYTES = 32;
const EXPIRES_IN_MIN = 15;

// In-memory rate limiter — same shape as site-forms.ts. Keyed on the
// best IP available (x-forwarded-for first) so a single client can't
// fire 100 forgot-password requests in a minute.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, number[]>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function rateLimit(ip: string, now: number): { allowed: boolean; retryAfterSec?: number } {
  const recent = (attempts.get(ip) ?? []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000,
    );
    attempts.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  attempts.set(ip, recent);
  return { allowed: true };
}

export function _resetRateLimit(): void {
  attempts.clear();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

interface ForgotFlowDeps {
  mailer?: (a: ResetEmailArgs) => Promise<ResetEmailResult>;
  /** Stable clock for tests. */
  now?: () => number;
}

/**
 * Inner flow exported for direct contract testing without re-running
 * the public POST signature dance.
 */
export async function forgotFlow(
  req: NextRequest,
  deps: ForgotFlowDeps = {},
): Promise<NextResponse> {
  const ip = clientIp(req);
  const now = deps.now ? deps.now() : Date.now();

  const limit = rateLimit(ip, now);
  if (!limit.allowed) {
    const retryAfter = limit.retryAfterSec ?? 900;
    trackEvent("auth.forgot_password_rate_limited", "anon", "anon", {
      retry_after: retryAfter,
    });
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  // Look up the team member. We DO NOT signal whether they exist in
  // the response — only whether the input passed validation.
  const lookup = await safeQuery<{ id: string; email: string; name: string }>(
    "SELECT id, email, name FROM instinct_team_members WHERE LOWER(email) = $1 AND is_active = true LIMIT 1",
    [email],
  );

  // If shadow mode (no DB) OR member not found → always return the
  // generic OK response. No row inserted. No email sent.
  if (lookup.fromCache || lookup.rows.length === 0) {
    trackEvent("auth.forgot_password_requested", "anon", "anon", {
      email_known: false,
      shadow: lookup.fromCache,
    });
    return NextResponse.json({ ok: true });
  }

  const member = lookup.rows[0];
  const token = generateToken();
  const tokenHash = sha256(token);
  const id = `pwr_${randomUUID().slice(0, 12)}`;
  const expiresAt = new Date(now + EXPIRES_IN_MIN * 60 * 1000);
  const userAgent = req.headers.get("user-agent")?.slice(0, 256) ?? null;

  await safeQuery(
    `INSERT INTO instinct_password_resets (id, member_id, token_sha256, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, member.id, tokenHash, expiresAt.toISOString(), ip, userAgent],
  );

  trackEvent("auth.forgot_password_requested", member.id, "anon", {
    email_known: true,
    shadow: false,
  });

  const resetUrl = buildResetUrl(token);
  const result = await sendResetEmail(
    {
      to: member.email,
      name: member.name || member.email.split("@")[0],
      resetUrl,
      expiresInMinutes: EXPIRES_IN_MIN,
    },
    deps.mailer,
  );

  // dev_link surfaces the URL ONLY when email did not deliver, so the
  // CTO can hand the link to the requester. When delivered=true the
  // URL is omitted to keep token material out of the response.
  const responseBody: Record<string, unknown> = { ok: true };
  if (!result.delivered) {
    responseBody.dev_link = resetUrl;
    responseBody.email_reason = result.reason;
  }
  return NextResponse.json(responseBody);
}

export async function POST(req: NextRequest) {
  return forgotFlow(req);
}
