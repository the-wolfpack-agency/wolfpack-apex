/**
 * POST /api/emails/[id]/reply — reply, reply-all, or forward a message.
 *
 * Body: {
 *   kind: "reply" | "replyAll" | "forward",
 *   bodyHtml?: string,
 *   bodyText?: string,
 *   to?: string[]      // required when kind === "forward"
 * }
 *
 * Returns 202 on accept with `{ id }`. Same error shape as
 * /api/mail/reply (scope_missing/429/401/etc).
 *
 * Rate limit: shares the /api/mail/send 30/hr per-user bucket — replies
 * cost the same Mail.Send budget. We import the limiter rather than
 * creating a parallel one so a user can't bypass it by switching surfaces.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  replyToMessage,
  replyAllToMessage,
  forwardMessage,
} from "@/lib/integrations/microsoft-mail";
import { _isRateLimited } from "@/app/api/mail/send/route";

type ReplyKind = "reply" | "replyAll" | "forward";

function parseKind(v: unknown): ReplyKind | null {
  if (v === "reply" || v === "replyAll" || v === "forward") return v;
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { limited, retryAfter } = _isRateLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "emails/[id]/reply",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const auth = await requireCapability(req, "emails.send");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const params = await ctx.params;
  const id = String(params?.id ?? "").trim();
  if (!id) {
    return NextResponse.json(
      { error: "invalid_input", detail: "id required" },
      { status: 400 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "invalid_json" },
      { status: 400 },
    );
  }

  const kind = parseKind(body.kind);
  if (!kind) {
    return NextResponse.json(
      { error: "invalid_input", detail: "kind must be reply | replyAll | forward" },
      { status: 400 },
    );
  }
  const input = {
    bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined,
    bodyText: typeof body.bodyText === "string" ? body.bodyText : undefined,
  };
  if (!input.bodyHtml && !input.bodyText) {
    return NextResponse.json(
      { error: "invalid_input", detail: "body required" },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof replyToMessage>>;
  if (kind === "reply") {
    result = await replyToMessage(user.id, id, input, user.role);
  } else if (kind === "replyAll") {
    result = await replyAllToMessage(user.id, id, input, user.role);
  } else {
    const to = Array.isArray(body.to) ? (body.to as string[]) : [];
    if (to.length === 0) {
      return NextResponse.json(
        { error: "invalid_input", detail: "to required for forward" },
        { status: 400 },
      );
    }
    result = await forwardMessage(user.id, id, to, input, user.role);
  }

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
        if (result.status === 404) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        return NextResponse.json(
          { error: "graph_error", status: result.status, detail: result.message },
          { status: 502 },
        );
      default:
        return NextResponse.json(
          { error: "internal", detail: result.message },
          { status: 500 },
        );
    }
  }

  return NextResponse.json({ id: result.value.id, kind }, { status: 202 });
}
