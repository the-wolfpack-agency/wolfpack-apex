/**
 * POST /api/groups/sync — force a Graph → cache sync of the caller's
 * Microsoft 365 Groups. Rate-limited per-user: 1 request / 5 min.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { syncGroups } from "@/lib/integrations/microsoft-groups";
import { recordAudit } from "@/lib/audit-log";

const attempts = new Map<string, { lastAt: number }>();
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export function _isRateLimited(userId: string, now = Date.now()): { limited: boolean; retryAfter: number } {
  const entry = attempts.get(userId);
  if (entry && now - entry.lastAt < MIN_INTERVAL_MS) {
    return { limited: true, retryAfter: Math.ceil((MIN_INTERVAL_MS - (now - entry.lastAt)) / 1000) };
  }
  attempts.set(userId, { lastAt: now });
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  attempts.clear();
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { limited, retryAfter } = _isRateLimited(user.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", user.id, user.role, { endpoint: "groups/sync" });
    return NextResponse.json(
      { error: "Sync already ran recently — try again in a moment" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const result = await syncGroups(user.id);
  if (!result.ok) {
    const status =
      result.code === "not_connected" ? 401 :
      result.code === "scope_missing" ? 403 :
      result.code === "rate_limited" ? 429 :
      result.status ?? 502;
    return NextResponse.json(
      { error: result.code, scope: result.scope, message: result.message },
      { status },
    );
  }

  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "groups.synced",
    resourceType: "ms_groups",
    afterState: { count: result.value.count, duration_ms: result.value.durationMs },
  }).catch(() => undefined);

  return NextResponse.json(result.value);
}
