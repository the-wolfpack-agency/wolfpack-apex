/**
 * POST /api/mail/send — send a new email via Microsoft Graph Mail.Send.
 *
 * Auth + capability: prefers `emails.send`; falls back to plain auth if
 * the capability isn't registered (keeps the route available for admins
 * in workspaces that haven't yet run 021_capability_overrides).
 *
 * Rate limited: 30 requests / hr / user. The same per-user, in-memory
 * shape as /api/tasks/sync — swapped out for Redis in multi-replica prod.
 *
 * Body:
 *   { to: string[], cc?: string[], bcc?: string[], subject: string,
 *     bodyHtml?: string, bodyText?: string, saveToSentItems?: boolean }
 *
 * Returns 202 on accept with `{ id, savedToSent }`. Error shape:
 *   403 { error:"forbidden", code:"scope_missing", scope:"Mail.Send" }
 *   429 { error:"rate_limited", retryAfter:<seconds> }
 *   401 { error:"unauthorized" } or { error:"microsoft_not_connected" }
 *   400 { error:"invalid_input", detail }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { notify } from "@/lib/notifications/in-app";
import { sendMail } from "@/lib/integrations/microsoft-mail";

// ---------------------------------------------------------------------------
// Per-user rate limiter — 30/hr.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const mailSendAttempts = new Map<string, { count: number; windowStart: number }>();

export function _isRateLimited(userId: string, now = Date.now()): { limited: boolean; retryAfter: number } {
  const entry = mailSendAttempts.get(userId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    mailSendAttempts.set(userId, { count: 1, windowStart: now });
    return { limited: false, retryAfter: 0 };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  entry.count++;
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  mailSendAttempts.clear();
}

// ---------------------------------------------------------------------------
// Auth helper that prefers capability but falls back gracefully.
// ---------------------------------------------------------------------------

async function authorize(req: NextRequest) {
  // Prefer capability check. If the capability is registered, requireCapability
  // handles analytics + 401/403. If the team hasn't rolled out capability
  // overrides, the `emails.send` cap resolves off role defaults which the
  // helper already handles.
  const auth = await requireCapability(req, "emails.send");
  if (auth.ok) return { ok: true as const, user: auth.user };
  return { ok: false as const, response: auth.response };
}

export async function POST(req: NextRequest) {
  // Fast 401 for unauth before we hit rate limit or body parse.
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Rate limit FIRST (before capability check so probing doesn't cost us).
  const { limited, retryAfter } = _isRateLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "mail/send",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // Capability / auth.
  const auth = await authorize(req);
  if (!auth.ok) return auth.response;
  const { user } = auth;

  // Body parse + shape.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_input", detail: "missing_body" }, { status: 400 });
  }

  const input = {
    to: Array.isArray(body.to) ? (body.to as string[]) : [],
    cc: Array.isArray(body.cc) ? (body.cc as string[]) : undefined,
    bcc: Array.isArray(body.bcc) ? (body.bcc as string[]) : undefined,
    subject: typeof body.subject === "string" ? body.subject : "",
    bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined,
    bodyText: typeof body.bodyText === "string" ? body.bodyText : undefined,
    saveToSentItems: body.saveToSentItems === false ? false : true,
  };

  const result = await sendMail(user.id, input, user.role);

  if (!result.ok) {
    switch (result.code) {
      case "invalid_input":
        return NextResponse.json(
          { error: "invalid_input", detail: result.message ?? "invalid" },
          { status: 400 },
        );
      case "scope_missing":
        return NextResponse.json(
          { error: "forbidden", code: "scope_missing", scope: result.scope ?? "Mail.Send" },
          { status: 403 },
        );
      case "rate_limited":
        return NextResponse.json(
          { error: "rate_limited", retryAfter: result.retryAfter ?? 60 },
          { status: 429, headers: { "Retry-After": String(result.retryAfter ?? 60) } },
        );
      case "not_connected":
        return NextResponse.json(
          { error: "microsoft_not_connected" },
          { status: 401 },
        );
      case "graph_error":
        return NextResponse.json(
          { error: "graph_error", status: result.status, detail: result.message },
          { status: 502 },
        );
      default:
        return NextResponse.json({ error: "internal", detail: result.message }, { status: 500 });
    }
  }

  // Optional notification — fire-and-forget, never blocks the response.
  notify({
    userId: user.id,
    category: "email",
    priority: "low",
    title: "Email sent",
    body: `"${input.subject}" to ${input.to.length} recipient${input.to.length === 1 ? "" : "s"}`,
    source: "instinct.mail",
    sourceId: result.value.id,
  }).catch(() => {});

  return NextResponse.json(
    { id: result.value.id, savedToSent: result.value.savedToSent },
    { status: 202 },
  );
}
