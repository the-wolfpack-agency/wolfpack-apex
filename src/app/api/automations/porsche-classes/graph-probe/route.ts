/**
 * GET /api/automations/porsche-classes/graph-probe
 *   ?user=homyk@thewolfpack.agency
 *
 * Tells us, for the configured user_id, exactly what Graph sees right
 * now: the token's UPN (`/me`), the 5 newest Inbox messages
 * (`/me/mailFolders/inbox/messages`), and whether the ErrorMailboxMove-
 * InProgress signature is in any Graph response. We need this when the
 * automation poll returns Seen 0 even though a fresh email is sitting
 * in the user's Inbox — it discriminates between "token bound to wrong
 * mailbox", "mailbox is mid-move", and "delta cursor stuck".
 *
 * Auth: cron-secret bearer OR `automations.run` (looser than the
 * existing /diag's `automations.view` so an operator who can run polls
 * can also probe Graph directly).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getValidToken } from "@/lib/microsoft-graph";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function graphGet(token: string, path: string) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as raw text */
  }
  return { status: res.status, body };
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    const auth = await requireCapability(req, "automations.run");
    if (!auth.ok) return auth.response;
  }
  const url = new URL(req.url);
  const userId =
    url.searchParams.get("user") ||
    process.env.AUTOMATION_POLL_USER_ID ||
    "homyk@thewolfpack.agency";

  const tok = await getValidToken(userId);
  if (!tok) {
    return NextResponse.json({
      user_id: userId,
      token_present: false,
      reason: "no_valid_token",
    });
  }

  const me = await graphGet(tok.accessToken, "me");
  const inbox = await graphGet(
    tok.accessToken,
    "me/mailFolders/inbox/messages?$top=5&$select=id,subject,from,receivedDateTime",
  );
  const inboxFolder = await graphGet(
    tok.accessToken,
    "me/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount",
  );

  /* Test the EXACT URL the inbox-list fallback builds. If this returns
     0 items but the unfiltered probe above returns N, the receivedDateTime
     ge filter is the bug — possibly a format Graph rejects silently. */
  const sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const filterUrl =
    `me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc` +
    `&$select=id,subject,bodyPreview,from,toRecipients,hasAttachments,receivedDateTime,lastModifiedDateTime` +
    `&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`;
  const filtered = await graphGet(tok.accessToken, filterUrl);

  return NextResponse.json({
    user_id: userId,
    token_email: tok.userEmail,
    me_status: me.status,
    me: me.body,
    inbox_folder_status: inboxFolder.status,
    inbox_folder: inboxFolder.body,
    inbox_messages_status: inbox.status,
    inbox_messages: inbox.body,
    fallback_filter_iso: sinceIso,
    fallback_filter_url: filterUrl,
    fallback_filter_status: filtered.status,
    fallback_filter_count:
      filtered.body && typeof filtered.body === "object" && "value" in (filtered.body as Record<string, unknown>)
        ? Array.isArray((filtered.body as { value?: unknown }).value)
          ? ((filtered.body as { value: unknown[] }).value).length
          : "non-array-value"
        : "no-value-key",
    fallback_filter_body: filtered.body,
  });
}
