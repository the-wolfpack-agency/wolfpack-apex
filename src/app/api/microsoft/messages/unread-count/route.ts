/**
 * GET /api/microsoft/messages/unread-count — sidebar Email badge poll.
 *
 * Mirrors the contract of /api/ms/chats/unread-count but for the
 * Microsoft Graph /me/mailFolders/inbox/messages surface. The raw
 * Graph call relied on:
 *
 *   GET /me/mailFolders/inbox/messages
 *       ?$count=true&$filter=isRead eq false&$top=1
 *
 *   Header: ConsistencyLevel: eventual   (required for $count=true)
 *
 * The header + query combo returns the OData `@odata.count` for the
 * filtered set, which is what we want — total unread inbox messages,
 * not a paged list. We also pull the top 5 unread messages so the
 * route can fan-out new email_arrived notifications to the bell when
 * the client passes a `since` cursor.
 *
 * Response shape (always 200 on the happy / degraded paths — the
 * badge is a nice-to-have, never a blocker):
 *
 *   - 401 { error: "Unauthorized" }       — no Instinct JWT
 *   - 200 { count: 0, connected: false }  — user has not linked MS
 *   - 200 { count: 0, scope_missing: true } — Graph reported 403
 *   - 200 { count, since? }               — happy path; `since` echoed
 *                                           when the client sent one.
 *
 * Errors degrade to { count: 0 } — never throw to the client. Fires
 * `microsoft.email_unread_polled` on every resolved call so the
 * learning loop sees real-world badge pressure (zero LLM tokens).
 *
 * Bell integration: when `?since=<ISO>` is supplied AND Graph returns
 * messages whose receivedDateTime > since, we call notify() for each
 * (deduped on Graph message id) so the top-right bell surfaces
 * "New email from {sender}" entries. Capped at 5 to avoid flooding.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import { notify } from "@/lib/notifications/in-app";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const NOTIFY_CAP = 5;

interface GraphMessage {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  receivedDateTime: string | null;
  isRead: boolean;
  webLink?: string | null;
  from?: {
    emailAddress?: {
      name?: string | null;
      address?: string | null;
    } | null;
  } | null;
}

interface GraphListResponse {
  "@odata.count"?: number;
  value?: GraphMessage[];
}

function parseSince(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return ms;
}

function senderLabel(msg: GraphMessage): string {
  const ea = msg.from?.emailAddress;
  if (!ea) return "Unknown sender";
  return ea.name || ea.address || "Unknown sender";
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sinceMs = parseSince(url.searchParams.get("since"));
  const sinceIso = sinceMs !== null ? new Date(sinceMs).toISOString() : null;

  try {
    const token = await getValidToken(user.id);
    if (!token) {
      trackEvent("microsoft.email_unread_polled", user.id, user.role, {
        count: 0,
        connected: false,
      });
      return NextResponse.json({ count: 0, connected: false });
    }

    // We pull a small window of unread messages (top 5) so the bell
    // fan-out can run off the same Graph call. $count=true requires
    // the ConsistencyLevel: eventual header; without it Graph returns
    // 400 "InvalidRequest" for `$count` on a filtered set.
    const top = NOTIFY_CAP;
    const select = "id,subject,bodyPreview,receivedDateTime,isRead,from,webLink";
    const endpoint =
      `${GRAPH_BASE}/me/mailFolders/inbox/messages` +
      `?$count=true` +
      `&$filter=${encodeURIComponent("isRead eq false")}` +
      `&$top=${top}` +
      `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
      `&$select=${encodeURIComponent(select)}`;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          ConsistencyLevel: "eventual",
        },
      });
    } catch (err) {
      // Network failure — degrade to zero, never throw.
      console.error(
        "[api/microsoft/messages/unread-count] graph network error:",
        (err as Error).message,
      );
      trackEvent("microsoft.email_unread_polled", user.id, user.role, {
        count: 0,
        graph_status: 0,
      });
      return NextResponse.json({ count: 0 });
    }

    if (res.status === 401 || res.status === 403) {
      trackEvent("microsoft.email_unread_polled", user.id, user.role, {
        count: 0,
        scope_missing: true,
      });
      return NextResponse.json({ count: 0, scope_missing: true });
    }

    if (!res.ok) {
      // 5xx / 429 / other — graceful degradation. No throw.
      trackEvent("microsoft.email_unread_polled", user.id, user.role, {
        count: 0,
        graph_status: res.status,
      });
      return NextResponse.json({ count: 0 });
    }

    const data = (await res.json().catch(() => null)) as GraphListResponse | null;
    const count =
      typeof data?.["@odata.count"] === "number" ? data["@odata.count"] : 0;
    const messages = Array.isArray(data?.value) ? data!.value : [];

    // Bell fan-out — only when the client passed a `since` cursor.
    // First poll (no since) is silent so users don't get flooded
    // with backlog notifications the moment they open Instinct.
    if (sinceMs !== null && messages.length > 0) {
      let notified = 0;
      for (const msg of messages) {
        if (notified >= NOTIFY_CAP) break;
        const ts = msg.receivedDateTime
          ? Date.parse(msg.receivedDateTime)
          : NaN;
        if (Number.isNaN(ts)) continue;
        if (ts <= sinceMs) continue;
        const subject = msg.subject?.trim() || "(no subject)";
        const sender = senderLabel(msg);
        try {
          /* Prefer Outlook webLink so users land in their real
             mailbox (where they reply, archive, file). Fallback to
             the in-app reader path when MS Graph somehow doesn't
             return a webLink for the message. */
          const actionUrl = msg.webLink
            ? msg.webLink
            : `/emails/${encodeURIComponent(msg.id)}`;
          await notify({
            userId: user.id,
            category: "email_arrived",
            priority: "normal",
            title: `New email from ${sender}`,
            body: subject,
            actionUrl,
            actionLabel: "Open in Outlook",
            source: "microsoft.email",
            sourceId: msg.id,
            metadata: {
              kind: "email_arrived",
              message_id: msg.id,
              sender,
              subject,
              arrived_at: msg.receivedDateTime,
            },
            dedup: true,
            expiresInHours: 72,
          });
          notified += 1;
        } catch (err) {
          console.warn(
            "[api/microsoft/messages/unread-count] notify failed:",
            (err as Error).message,
          );
        }
      }
      if (notified > 0) {
        trackEvent("microsoft.email_arrived_notified", user.id, user.role, {
          count: notified,
          unread_total: count,
        });
      }
    }

    trackEvent("microsoft.email_unread_polled", user.id, user.role, {
      count,
      has_since: sinceMs !== null,
    });

    return NextResponse.json({
      count,
      since: sinceIso,
    });
  } catch (err) {
    // Last-resort guard: NEVER throw to the client. The badge is a
    // nice-to-have; a 500 would surface a red console error every
    // 60s for every signed-in user.
    console.error(
      "[api/microsoft/messages/unread-count] error:",
      (err as Error).message,
    );
    return NextResponse.json({ count: 0 });
  }
}
