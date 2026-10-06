/**
 * POST /api/forcefield/signup - PUBLIC, GATED self-serve request.
 *
 * PUBLIC: unauthenticated by design - a prospect on the marketing site submits
 * this before any account exists. It is NOT capability-gated; it is protected by
 * an in-memory per-IP rate limit, a honeypot field, and strict validation. It
 * NEVER mints a token - it only enqueues a PENDING request an operator reviews
 * (see /api/admin/forcefield/signups). That gate is the anti-abuse boundary.
 *
 * Always answers with a success shape on a valid-looking submit (even a tripped
 * honeypot) so a bot learns nothing; a real failure is 400/429. Never 500s.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { createSignupRequest, hashIp, RATE_LIMIT_WINDOW_MS } from "@/lib/forcefield-web/signup";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const meta = extractRequestMetadata(req);
  const ipHash = hashIp(meta.ipAddress);

  const result = await createSignupRequest({ raw, ipHash });

  if (result.reason === "rate_limited") {
    // Durable fixed-window limiter: Retry-After is the window length.
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) } },
    );
  }
  if (result.reason === "invalid") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  // A real, new request: audit it, record the signal, and (best-effort) nothing leaks.
  if (result.reason === "ok" && result.requestId) {
    await recordAudit({
      actor: { user_id: "anonymous", role: "public" },
      action: "forcefield.signup_requested",
      resourceType: "forcefield_signup_request",
      resourceId: result.requestId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch(() => {});
    void trackEvent("forcefield.signup_requested", "anonymous", "public", { requestId: result.requestId });
  }

  // honeypot / duplicate / ok all answer the client identically: received.
  return NextResponse.json({ ok: true, status: "received" }, { status: 202 });
}
