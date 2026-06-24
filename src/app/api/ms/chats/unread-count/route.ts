/**
 * GET /api/ms/chats/unread-count — badge poll for the top-nav Teams
 * unread indicator (see `src/components/TeamsUnreadBadge.tsx`).
 *
 * The Microsoft Graph `/me/chats` endpoint does NOT expose a per-chat
 * `unreadCount` field on the delegated Chat.Read scope. To keep this
 * PR minimal (no delta cursors, no extra scope), we implement a
 * client-collaborated heuristic:
 *
 *   - The client passes `?since=<ISO8601>` — the timestamp at which
 *     the user last viewed /messages (stored in localStorage under
 *     `instinct.messages.last_seen`).
 *   - We call the existing `listChatsResult` lib (reused, not
 *     modified) and count chats whose `lastUpdatedDateTime > since`.
 *   - First poll (no `since`) returns 0 so we never flash a stale
 *     badge the instant the user logs in.
 *
 * Response shape (always 200 on the happy / degraded paths — the
 * badge is a nice-to-have, never a blocker):
 *
 *   { count, connected, scope_missing?, total_chats, since }
 *
 *   - 401 { error: "Unauthorized" }       — no Instinct JWT
 *   - 200 { count: 0, connected: false }  — user has not linked MS
 *   - 200 { count: 0, scope_missing: true } — user needs Chat.Read
 *   - 200 { count, total_chats, since }   — happy path
 *   - 500 { error: "Internal error" }     — unexpected failure
 *
 * Fires `messages.unread_count_polled` with `{ count }` on every
 * resolved call so the learning loop sees real-world badge pressure.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { listChatsResult } from "@/lib/ms-graph-chats";
import { isNotificationWorthy } from "@/lib/messages/message-classify";
import { trackEvent } from "@/lib/analytics";

/**
 * Parse `since` into a millisecond timestamp. Returns null when the
 * value is absent, empty, or not a valid ISO date — callers treat
 * null as "first poll, return 0".
 */
function parseSince(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return ms;
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const since = parseSince(url.searchParams.get("since"));

    const token = await getValidToken(user.id);
    if (!token) {
      trackEvent("messages.unread_count_polled", user.id, user.role, {
        count: 0,
        connected: false,
      });
      return NextResponse.json({ count: 0, connected: false });
    }

    const result = await listChatsResult(token.accessToken, 50, user.id);
    if (!result.ok) {
      trackEvent("messages.unread_count_polled", user.id, user.role, {
        count: 0,
        scope_missing: true,
      });
      return NextResponse.json({ count: 0, scope_missing: true });
    }

    const total = result.chats.length;
    // First poll (no `since`) → 0 so we never show a flash badge the
    // moment a user logs in. The client will set `last_seen` to now()
    // on first click and subsequent polls will be accurate.
    //
    // We also only count a chat whose latest message is a GENUINE typed human
    // message. Graph reports lastUpdatedDateTime for system + meeting events
    // (call started/ended, member added, meeting invite / scheduled, meeting
    // recording posted) and for attachment-only cards even when there is no
    // human message. Those are exactly what the message timeline drops or
    // renders as a pill, so the badge must agree: a meeting invite is not a
    // "new message" and must not flash a notification. `isNotificationWorthy`
    // is the shared predicate the timeline renderer uses, so the count and the
    // timeline can never disagree. Bug fix 2026-06-19 (blank meeting-invite
    // notification); supersedes the inline messageType/body/deleted checks.
    let count = 0;
    if (since !== null) {
      for (const chat of result.chats) {
        const ts = chat.lastUpdatedDateTime
          ? Date.parse(chat.lastUpdatedDateTime)
          : NaN;
        if (Number.isNaN(ts) || ts <= since) continue;
        const preview = chat.lastMessagePreview;
        if (!preview) continue;
        if (!isNotificationWorthy(preview)) continue;
        count += 1;
      }
    }

    trackEvent("messages.unread_count_polled", user.id, user.role, {
      count,
      total_chats: total,
      has_since: since !== null,
    });

    return NextResponse.json({
      count,
      total_chats: total,
      since: since !== null ? new Date(since).toISOString() : null,
    });
  } catch (err) {
    console.error("[api/ms/chats/unread-count] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
