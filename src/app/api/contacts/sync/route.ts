/**
 * POST /api/contacts/sync — force a full/delta sync.
 *
 * Rate-limited to 1 request / 10 minutes / user. Heavy operation: walks
 * every contact (on first sync) or every change since last delta.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { syncAllContacts, GraphContactsError } from "@/lib/integrations/microsoft-contacts";

const SYNC_RATE_LIMIT_MS = 10 * 60 * 1000;
const syncAttempts = new Map<string, { lastAt: number }>();

export function _isRateLimited(userId: string, now = Date.now()): { limited: boolean; retryAfter: number } {
  const entry = syncAttempts.get(userId);
  if (entry && now - entry.lastAt < SYNC_RATE_LIMIT_MS) {
    return { limited: true, retryAfter: Math.ceil((SYNC_RATE_LIMIT_MS - (now - entry.lastAt)) / 1000) };
  }
  syncAttempts.set(userId, { lastAt: now });
  return { limited: false, retryAfter: 0 };
}

export function _resetContactsSyncRateLimit(): void {
  syncAttempts.clear();
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { limited, retryAfter } = _isRateLimited(user.id);
  if (limited) {
    trackEvent("system.upload_rate_limited", user.id, user.role, { endpoint: "contacts/sync" });
    return NextResponse.json(
      { error: "Sync already ran recently — try again later" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const result = await syncAllContacts(user.id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GraphContactsError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Contacts.ReadWrite" }, { status: 403 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
