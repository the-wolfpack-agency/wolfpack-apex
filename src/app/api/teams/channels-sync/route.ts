/**
 * POST /api/teams/channels-sync — force Teams-channels Graph→cache sync.
 *
 * Rate-limited per-user: 1 request per 5 minutes. Walks joinedTeams →
 * channels → messages + replies and upserts + RAG-indexes every message.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  syncAllChannels,
  ChannelMessagesError,
  asScopeMissing,
} from "@/lib/integrations/microsoft-channel-messages";

// Per-user rate limiter (1 per 5 min). Process-local.
const syncAttempts = new Map<string, { lastAt: number }>();
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export function _isRateLimited(
  userId: string,
  now = Date.now(),
): { limited: boolean; retryAfter: number } {
  const entry = syncAttempts.get(userId);
  if (entry && now - entry.lastAt < MIN_INTERVAL_MS) {
    return {
      limited: true,
      retryAfter: Math.ceil((MIN_INTERVAL_MS - (now - entry.lastAt)) / 1000),
    };
  }
  syncAttempts.set(userId, { lastAt: now });
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  syncAttempts.clear();
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { limited, retryAfter } = _isRateLimited(user.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", user.id, user.role, {
      endpoint: "teams/channels-sync",
    });
    return NextResponse.json(
      { error: "Sync already ran recently — try again in a moment" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: { messagesPerChannel?: number } = {};
  try {
    if (
      req.headers.get("content-length") &&
      req.headers.get("content-length") !== "0"
    ) {
      body = await req.json();
    }
  } catch {
    body = {};
  }

  try {
    const result = await syncAllChannels(user.id, {
      messagesPerChannel: body.messagesPerChannel,
    });
    return NextResponse.json(result);
  } catch (err) {
    const scope = asScopeMissing(err, "ChannelMessage.Read.All");
    if (scope) return NextResponse.json(scope, { status: 403 });

    if (err instanceof ChannelMessagesError) {
      if (err.status === 401) {
        return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      }
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Microsoft Graph rate limit" },
          {
            status: 429,
            headers: err.retryAfter
              ? { "Retry-After": String(err.retryAfter) }
              : undefined,
          },
        );
      }
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
