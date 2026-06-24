/**
 * POST /api/mail/draft — create an Outlook DRAFT (never send).
 *
 * The safe, reversible compose action: the message lands in the user's Drafts
 * folder for review. This is what an agent is allowed to do on its owner's
 * behalf (the OGIAM gate escalates an actual send; a draft has no external
 * effect). Same capability + typed-error contract as /api/mail/send.
 *
 * Responses:
 *   201 { id, webLink? }                                  — draft created
 *   400 { error:"invalid_input", detail }                 — bad body / missing to/subject/body
 *   401 { error:"unauthorized" | "microsoft_not_connected" }
 *   403 { error:"forbidden", code:"scope_missing", scope:"Mail.ReadWrite" }
 *   429 { error:"rate_limited", retryAfter }
 *   502 { error:"graph_error" } / 500 { error:"internal" }
 *
 * Emits mail.draft_created on success (via the integration) so the action feeds
 * analytics + audit. When invoked by an agent on-behalf, the dispatcher also
 * records the OGIAM decision + outcome + Brain summary.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { createDraft } from "@/lib/integrations/microsoft-mail";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 60; // drafts are cheaper than sends; a touch higher.
const draftAttempts = new Map<string, { count: number; windowStart: number }>();

export function _isDraftRateLimited(
  userId: string,
  now = Date.now(),
): { limited: boolean; retryAfter: number } {
  const entry = draftAttempts.get(userId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    draftAttempts.set(userId, { count: 1, windowStart: now });
    return { limited: false, retryAfter: 0 };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  entry.count++;
  return { limited: false, retryAfter: 0 };
}

export function _resetDraftRateLimit(): void {
  draftAttempts.clear();
}

export async function POST(req: NextRequest) {
  const quickUser = getUserFromRequest(req.headers.get("authorization"));
  if (!quickUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { limited, retryAfter } = _isDraftRateLimited(quickUser.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", quickUser.id, quickUser.role, {
      endpoint: "mail/draft",
    });
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // Compose authority. Drafting reuses the send capability (a principal who can
  // compose/send can draft); the gate keeps the actual send human-approved.
  const auth = await requireCapability(req, "emails.send");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_input", detail: "missing_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // `to` accepts a string or string[] (the agent operation extracts one address).
  const to = Array.isArray(b.to)
    ? (b.to as string[])
    : typeof b.to === "string" && b.to.trim()
      ? [b.to.trim()]
      : [];

  const input = {
    to,
    subject: typeof b.subject === "string" ? b.subject : "",
    bodyHtml: typeof b.bodyHtml === "string" ? b.bodyHtml : undefined,
    bodyText: typeof b.bodyText === "string" ? b.bodyText : undefined,
  };

  const result = await createDraft(user.id, input, user.role);

  if (!result.ok) {
    switch (result.code) {
      case "invalid_input":
        return NextResponse.json(
          { error: "invalid_input", detail: result.message ?? "invalid" },
          { status: 400 },
        );
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

  return NextResponse.json(
    { id: result.value.id, webLink: result.value.webLink, message: "Draft created for review." },
    { status: 201 },
  );
}
