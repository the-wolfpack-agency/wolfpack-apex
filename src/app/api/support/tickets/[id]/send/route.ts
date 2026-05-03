/**
 * POST /api/support/tickets/[id]/send — send the support response from the
 * shared support@thewolfpack.agency mailbox via Microsoft Graph.
 *
 * Body: { to_email, subject?, body? }
 *   - subject defaults to ticket.title
 *   - body defaults to ticket.sent_response (if present) else ticket.draft_response
 *
 * Two send paths, picked by ticket lineage:
 *   1. Reply path (preferred when ticket has graph_message_id) —
 *      `POST /me/messages/{graph_message_id}/reply` with
 *      `comment: <draft body>`. Microsoft Graph preserves the
 *      conversationId, threading the outbound message onto the same
 *      mail thread the inbound email started. The customer's reply
 *      will land back in support@ with the same conversationId, which
 *      the inbox poller routes onto THIS ticket via
 *      `findTicketByConversationId`. No duplicates.
 *   2. New-message path (manual /support form tickets) —
 *      `POST /me/sendMail` with `from: support@`. The operator must
 *      have Send-As granted on the shared mailbox.
 *
 * Both paths persist a row to instinct_support_ticket_messages with
 * direction='outbound' so the ticket detail page can render the full
 * thread audit.
 *
 * Auth: `automations.run` capability.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  appendTicketReply,
  getTicket,
  updateTicket,
} from "@/lib/support/repo";
import { getValidToken } from "@/lib/microsoft-graph";

const SUPPORT_FROM = "support@thewolfpack.agency";
const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

/** Graph "reply" URL for an existing message. The reply preserves the
 *  conversationId so threaded delivery works automatically. */
function graphReplyUrl(messageId: string): string {
  return `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`;
}

/* RFC 5321 caps a full email address at 254 chars; capping before the
   regex defeats ReDoS amplification on adversarial input where the
   `[^\s@]+` … `[^\s@]+\.[^\s@]+` alternation chain could backtrack. */
const MAX_EMAIL_LEN = 254;

function isValidEmail(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > MAX_EMAIL_LEN) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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

    /* Pick the send path. When the ticket has a graph_message_id the
       inbound email is the canonical thread root — using /reply keeps
       the conversationId intact so the customer's response lands back
       on this ticket. Manual-create tickets fall through to /sendMail
       with from=support@. */
    const useReplyPath = Boolean(ticket.graph_message_id);
    const graphUrl = useReplyPath
      ? graphReplyUrl(ticket.graph_message_id as string)
      : GRAPH_SEND_URL;
    const graphPayload = useReplyPath
      ? {
          /* Graph's /reply takes a `comment` (the prefix prepended to
             the quoted original) plus an optional `message` to
             override headers. We supply both: the comment carries the
             actual draft text, and `toRecipients` is overridden so
             the operator can re-route a reply (e.g. customer used a
             personal email originally, but support agreed to a work
             address). saveToSentItems is implicit on /reply. */
          comment: sentBody,
          message: {
            toRecipients: [{ emailAddress: { address: toEmail } }],
          },
        }
      : {
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
      res = await fetch(graphUrl, {
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

    /* Both /sendMail and /reply return 202 Accepted with no body — Graph
       does NOT echo back the new message id on these endpoints. We
       therefore record the outbound row with a synthetic id derived
       from the ticket + timestamp; when the message lands in the
       support@ Sent Items folder a future reconciliation pass can
       backfill the real Graph id. The audit table is the source of
       truth for "we sent this" — id immutability is the contract. */
    try {
      await appendTicketReply(id, {
        graph_message_id: `outbound:${id}:${Date.now()}`,
        internet_message_id: null,
        from_email: SUPPORT_FROM,
        body: sentBody,
        received_at: new Date().toISOString(),
        direction: "outbound",
      });
    } catch (err) {
      console.warn(
        "[support/tickets/send] appendTicketReply outbound failed:",
        (err as Error).message,
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
      send_path: useReplyPath ? "reply" : "send_mail",
    });

    return NextResponse.json({ ticket: updated ?? ticket });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
