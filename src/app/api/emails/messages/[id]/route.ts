/**
 * /api/emails/[id] — single-message mutations for the inbox view.
 *
 * Methods:
 *   PATCH  body: { isRead?: boolean, archive?: true }
 *          - Flips read state (Mail.ReadWrite) or moves to Archive folder.
 *          - { isRead: false } marks unread, { isRead: true } marks read.
 *          - { archive: true } moves the message to the user's Archive
 *            folder; the response includes the new id.
 *   DELETE soft-deletes (Graph DELETE /me/messages/{id} → Deleted Items).
 *
 * Auth: capability `emails.view` for PATCH (read-only operations on
 * mailbox), `emails.send` is NOT required (Mail.ReadWrite only). Delete
 * also stays gated on `emails.view` because Graph's soft-delete is
 * recoverable from Outlook.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  setMessageReadState,
  archiveMessage,
  deleteMessage,
} from "@/lib/integrations/microsoft-mail";
import { _isRateLimited as inboxLimited } from "../../inbox/route";

type AnyResult = Awaited<ReturnType<typeof setMessageReadState>>;

function mapErrorToResponse(result: Extract<AnyResult, { ok: false }>) {
  switch (result.code) {
    case "invalid_input":
      return NextResponse.json(
        { error: "invalid_input", detail: result.message ?? "invalid" },
        { status: 400 },
      );
    case "not_connected":
      return NextResponse.json({ error: "microsoft_not_connected" }, { status: 401 });
    case "scope_missing":
      return NextResponse.json(
        { error: "forbidden", code: "scope_missing", scope: result.scope ?? "Mail.ReadWrite" },
        { status: 403 },
      );
    case "rate_limited":
      return NextResponse.json(
        { error: "rate_limited", retryAfter: result.retryAfter ?? 60 },
        { status: 429, headers: { "Retry-After": String(result.retryAfter ?? 60) } },
      );
    case "graph_error":
      if (result.status === 404 || result.message === "not_found") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "graph_error", status: result.status, detail: result.message },
        { status: result.status && result.status >= 500 ? 502 : 502 },
      );
    default:
      return NextResponse.json({ error: "internal", detail: result.message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { limited, retryAfter } = inboxLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "emails/[id]/PATCH",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const auth = await requireCapability(req, "emails.view");
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "invalid_json" },
      { status: 400 },
    );
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (obj.archive === true) {
    const result = await archiveMessage(user.id, id);
    if (!result.ok) return mapErrorToResponse(result);
    return NextResponse.json({ id: result.value.id, archived: true }, { status: 200 });
  }

  if (typeof obj.isRead === "boolean") {
    const result = await setMessageReadState(user.id, id, obj.isRead);
    if (!result.ok) return mapErrorToResponse(result);
    return NextResponse.json({ id: result.value.id, isRead: result.value.isRead }, { status: 200 });
  }

  return NextResponse.json(
    { error: "invalid_input", detail: "isRead boolean or archive=true required" },
    { status: 400 },
  );
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { limited, retryAfter } = inboxLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "emails/[id]/DELETE",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const auth = await requireCapability(req, "emails.view");
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

  const result = await deleteMessage(user.id, id);
  if (!result.ok) return mapErrorToResponse(result);
  return NextResponse.json({ id: result.value.id, deleted: true }, { status: 200 });
}
