/**
 * POST /api/tasks/sync — force a full Graph → cache sync for the caller.
 *
 * Rate-limited per-user: 1 request per minute. Heavy operation — we walk
 * every list + every task. The webhook path + periodic scheduler (TODO)
 * should be the primary drivers; this endpoint is the manual fallback.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { syncAllForUser, GraphTasksError } from "@/lib/integrations/microsoft-tasks";

// Per-user rate limiter (1/min). Process-local; matches the pattern used
// in src/app/api/auth/login/route.ts. A Redis-backed limiter would be
// swapped in on top of this for multi-replica prod.
const syncAttempts = new Map<string, { lastAt: number }>();
const MIN_INTERVAL_MS = 60 * 1000;

export function _isRateLimited(userId: string, now = Date.now()): { limited: boolean; retryAfter: number } {
  const entry = syncAttempts.get(userId);
  if (entry && now - entry.lastAt < MIN_INTERVAL_MS) {
    return { limited: true, retryAfter: Math.ceil((MIN_INTERVAL_MS - (now - entry.lastAt)) / 1000) };
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
    trackEvent("system.upload_rate_limited", user.id, user.role, { endpoint: "tasks/sync" });
    return NextResponse.json(
      { error: "Sync already ran recently — try again in a moment" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const result = await syncAllForUser(user.id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GraphTasksError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
