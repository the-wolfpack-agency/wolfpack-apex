/**
 * POST /api/support/tickets/[id]/send — send the support response from the
 * shared support@thewolfpack.agency mailbox via Microsoft Graph.
 *
 * Body: { to_email, subject?, body? }
 *   - subject defaults to ticket.title
 *   - body defaults to ticket.sent_response (if present) else ticket.draft_response
 *
 * The Graph endpoint is `POST /me/sendMail` with the message `from`
 * field set to the shared support mailbox; the operator must have
 * Send-As permission for that mailbox.
 *
 * Auth: `automations.run` capability.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getTicket, updateTicket } from "@/lib/support/repo";
import { getValidToken } from "@/lib/microsoft-graph";

const SUPPORT_FROM = "support@thewolfpack.agency";
const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (!isValidEmail(b.to_email)) {
    return NextResponse.json(
      { error: "to_email_required" },
      { status: 400 },
    );
  }
  const toEmail = b.to_email;
  const overrideSubject =
    typeof b.subject === "string" && b.subject.length > 0 ? b.subject : null;
  const overrideBody =
    typeof b.body === "string" && b.body.length > 0 ? b.body : null;

  try {
    const { id } = await ctx.params;
    const ticket = await getTicket(id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const subject = overrideSubject ?? ticket.title ?? "Support response";
    const sentBody =
      overrideBody ?? ticket.sent_response ?? ticket.draft_response ?? "";
    if (!sentBody) {
      return NextResponse.json(
        { error: "no_body_to_send" },
        { status: 400 },
      );
    }

    const token = await getValidToken(auth.user.id);
    if (!token) {
      return NextResponse.json(
        { error: "no_token" },
        { status: 502 },
      );
    }

    const graphPayload = {
      message: {
        subject,
        from: { emailAddress: { address: SUPPORT_FROM } },
        body: { contentType: "Text", content: sentBody },
        toRecipients: [{ emailAddress: { address: toEmail } }],
      },
      saveToSentItems: true,
    };

    let res: Response;
    try {
      res = await fetch(GRAPH_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(graphPayload),
      });
    } catch (e) {
      return NextResponse.json(
        { error: "graph_error", detail: (e as Error).message },
        { status: 502 },
      );
    }

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { error: "no_token", status: res.status },
        { status: 502 },
      );
    }
    if (!res.ok && res.status !== 202) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      return NextResponse.json(
        { error: "graph_error", status: res.status, detail },
        { status: 502 },
      );
    }

    const updated = await updateTicket(id, {
      status: "sent",
      sent_at: new Date().toISOString(),
      sent_to_email: toEmail,
      sent_response: sentBody,
    });

    trackEvent("support.ticket_sent", auth.user.id, auth.user.role, {
      ticket_id: id,
      to_email: toEmail,
      char_count: sentBody.length,
    });

    return NextResponse.json({ ticket: updated ?? ticket });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
