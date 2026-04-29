/**
 * GET /api/emails/inbox — list inbox messages for the /emails page.
 *
 * Query params:
 *   ?top=25         (1–100, default 25)
 *   ?skip=0         (>=0, default 0)
 *   ?unread=true    (filter on isRead=false)
 *
 * Auth: capability `emails.view`. Same scope_missing / not_connected
 * treatment as the rest of the mail surface.
 *
 * Architecture note: live Graph fetch on every call. The
 * `microsoft-mail.listInbox` helper memoizes nothing — the page-level
 * cache lives in `lib/microsoft-graph.ts` (5min TTL). For an inbox
 * surface that changes by the second a longer cache misleads users,
 * and a local Postgres mirror would force a full delta-sync feature
 * we don't need yet. Keep this layer thin.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { listInbox, type ListInboxOptions } from "@/lib/integrations/microsoft-mail";

// ---------------------------------------------------------------------------
// Per-user rate limiter — 60/min. Inbox lists hit Graph hard so we cap.
// ---------------------------------------------------------------------------

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 60;
const inboxAttempts = new Map<string, { count: number; windowStart: number }>();

export function _isRateLimited(userId: string, now = Date.now()): { limited: boolean; retryAfter: number } {
  const entry = inboxAttempts.get(userId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    inboxAttempts.set(userId, { count: 1, windowStart: now });
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
  inboxAttempts.clear();
}

function parseOpts(req: NextRequest): ListInboxOptions {
  const u = new URL(req.url);
  const topRaw = parseInt(u.searchParams.get("top") ?? "25", 10);
  const skipRaw = parseInt(u.searchParams.get("skip") ?? "0", 10);
  const unread = u.searchParams.get("unread") === "true";
  return {
    top: Number.isFinite(topRaw) ? topRaw : 25,
    skip: Number.isFinite(skipRaw) ? skipRaw : 0,
    unreadOnly: unread,
  };
}

export async function GET(req: NextRequest) {
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { limited, retryAfter } = _isRateLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "emails/inbox",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const auth = await requireCapability(req, "emails.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const result = await listInbox(user.id, parseOpts(req));
  if (!result.ok) {
    switch (result.code) {
      case "not_connected":
        return NextResponse.json({ error: "microsoft_not_connected" }, { status: 401 });
      case "scope_missing":
        return NextResponse.json(
          { error: "forbidden", code: "scope_missing", scope: result.scope ?? "Mail.Read" },
          { status: 403 },
        );
      case "rate_limited":
        return NextResponse.json(
          { error: "rate_limited", retryAfter: result.retryAfter ?? 60 },
          { status: 429, headers: { "Retry-After": String(result.retryAfter ?? 60) } },
        );
      case "graph_error":
        return NextResponse.json(
          { error: "graph_error", status: result.status, detail: result.message },
          { status: 502 },
        );
      case "invalid_input":
        return NextResponse.json(
          { error: "invalid_input", detail: result.message ?? "invalid" },
          { status: 400 },
        );
      default:
        return NextResponse.json(
          { error: "internal", detail: result.message },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    {
      messages: result.value.messages,
      nextSkip: result.value.nextSkip,
      unreadCount: result.value.unreadCount,
    },
    { status: 200 },
  );
}
