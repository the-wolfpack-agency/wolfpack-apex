/**
 * GET /api/mail/[id] — read a single Outlook message by Graph id.
 *
 * Backs the /emails?id=<id> deep-link reading view (search results
 * link directly to a thread instead of dumping the user on a blank
 * compose form). Mail.Read scope only; reply/send remains gated on
 * Mail.Send via /api/mail/reply.
 *
 * Response shape (200):
 *   {
 *     message: {
 *       id, subject, receivedDateTime,
 *       from: { name, email },
 *       toRecipients: [{ name, email }, ...],
 *       ccRecipients: [{ name, email }, ...],
 *       bodyContentType: "html" | "text",
 *       bodyContent, bodyPreview, webLink
 *     }
 *   }
 *
 * Error shape:
 *   401 { error: "unauthorized" }                — no/invalid session
 *   401 { error: "microsoft_not_connected" }    — no MS token
 *   403 { error: "forbidden", code: "scope_missing", scope: "Mail.Read" }
 *   404 { error: "not_found" }                   — Graph rejected the id
 *   429 { error: "rate_limited", retryAfter }
 *   500 { error: "graph_error", message }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getMessage } from "@/lib/integrations/microsoft-mail";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = await ctx.params;
  const id = String(params?.id ?? "").trim();
  if (!id) {
    return NextResponse.json(
      { error: "invalid_input", detail: "id required" },
      { status: 400 },
    );
  }

  const result = await getMessage(user.id, id);
  if (!result.ok) {
    switch (result.code) {
      case "not_connected":
        return NextResponse.json(
          { error: "microsoft_not_connected" },
          { status: 401 },
        );
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
        if (result.status === 404 || result.message === "not_found") {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        return NextResponse.json(
          { error: "graph_error", message: result.message ?? "graph_error" },
          { status: result.status && result.status >= 400 ? result.status : 502 },
        );
      case "invalid_input":
        return NextResponse.json(
          { error: "invalid_input", detail: result.message ?? "invalid" },
          { status: 400 },
        );
      default:
        return NextResponse.json(
          { error: "internal", message: result.message ?? "internal" },
          { status: 500 },
        );
    }
  }

  return NextResponse.json({ message: result.value }, { status: 200 });
}
