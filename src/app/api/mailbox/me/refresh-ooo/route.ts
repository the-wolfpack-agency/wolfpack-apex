/**
 * POST /api/mailbox/me/refresh-ooo — pull Graph /me/mailboxSettings/auto-reply
 * and persist the OOO state locally.
 *
 * Rate-limited to 1 per 5 minutes. Audited with {was_enabled, is_enabled}
 * so compliance can reconstruct transitions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  refreshOwnOOOState,
  getCachedOOOState,
} from "@/lib/integrations/microsoft-mailbox";

const attempts = new Map<string, { lastAt: number }>();
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export function _isRateLimited(
  userId: string,
  now = Date.now(),
): { limited: boolean; retryAfter: number } {
  const entry = attempts.get(userId);
  if (entry && now - entry.lastAt < MIN_INTERVAL_MS) {
    return {
      limited: true,
      retryAfter: Math.ceil((MIN_INTERVAL_MS - (now - entry.lastAt)) / 1000),
    };
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
    trackEvent("system.upload_rate_limited", user.id, user.role, {
      endpoint: "mailbox/refresh-ooo",
    });
    return NextResponse.json(
      { error: "OOO refresh already ran recently — try again later" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const before = await getCachedOOOState(user.id);
  const state = await refreshOwnOOOState(user.id);

  const meta = extractRequestMetadata(req);
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "mailbox.ooo_refreshed",
      resourceType: "mailbox_ooo",
      resourceId: user.id,
      beforeState: before ? { is_enabled: before.isEnabled, scope: before.scope } : null,
      afterState: state ? { is_enabled: state.isEnabled, scope: state.scope } : null,
      ...meta,
    });
  } catch {
    /* audit must never block */
  }

  return NextResponse.json({ ooo: state });
}
