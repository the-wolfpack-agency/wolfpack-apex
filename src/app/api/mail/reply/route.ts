/**
 * POST /api/mail/reply — reply to an existing Graph message.
 *
 * Body: { originalMessageId: string, bodyHtml?: string, bodyText?: string }
 *
 * Same rate limit bucket as /api/mail/send (30/hr per user) — replying
 * costs the same Graph budget as sending.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { replyToMessage } from "@/lib/integrations/microsoft-mail";
import { _isRateLimited } from "@/app/api/mail/send/route";

export async function POST(req: NextRequest) {
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { limited, retryAfter } = _isRateLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "mail/reply",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const auth = await requireCapability(req, "emails.send");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_json" }, { status: 400 });
  }

  const originalMessageId = typeof body?.originalMessageId === "string" ? body.originalMessageId : "";
  if (!originalMessageId) {
    return NextResponse.json(
      { error: "invalid_input", detail: "originalMessageId required" },
      { status: 400 },
    );
  }
  const input = {
    bodyHtml: typeof body?.bodyHtml === "string" ? body.bodyHtml : undefined,
    bodyText: typeof body?.bodyText === "string" ? body.bodyText : undefined,
  };
  if (!input.bodyHtml && !input.bodyText) {
    return NextResponse.json({ error: "invalid_input", detail: "body required" }, { status: 400 });
  }

  const result = await replyToMessage(user.id, originalMessageId, input, user.role);

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
        return NextResponse.json({ error: "microsoft_not_connected" }, { status: 401 });
      case "graph_error":
        return NextResponse.json(
          { error: "graph_error", status: result.status, detail: result.message },
          { status: 502 },
        );
      default:
        return NextResponse.json({ error: "internal", detail: result.message }, { status: 500 });
    }
  }

  return NextResponse.json({ id: result.value.id }, { status: 202 });
}
