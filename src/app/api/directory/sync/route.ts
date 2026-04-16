/**
 * POST /api/directory/sync — force a tenant directory delta sync.
 *
 * Rate-limited per-user to 1 request per 15 minutes (directory is big;
 * we don't want to hammer Graph with this endpoint). Audit is recorded on
 * every successful sync with {count} in afterState.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  syncDirectory,
  DirectoryError,
  asScopeMissing,
} from "@/lib/integrations/microsoft-directory";

const syncAttempts = new Map<string, { lastAt: number }>();
const MIN_INTERVAL_MS = 15 * 60 * 1000;

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
      endpoint: "directory/sync",
    });
    return NextResponse.json(
      { error: "Directory sync already ran recently — try again later" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const result = await syncDirectory(user.id);
    if ("ok" in result && result.ok === false) {
      return NextResponse.json(result, { status: 403 });
    }

    // Narrowed: this is the SyncResult branch.
    const sync = result as { synced: number; durationMs: number; nextDeltaToken?: string };

    // Audit: sync is a write-through. `count` is the afterState.
    const meta = extractRequestMetadata(req);
    try {
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "directory.synced",
        resourceType: "ms_directory",
        afterState: { count: sync.synced, duration_ms: sync.durationMs },
        ...meta,
      });
    } catch {
      // audit must never block the route
    }

    return NextResponse.json(sync);
  } catch (err) {
    const scope = asScopeMissing(err, "User.Read.All");
    if (scope) return NextResponse.json(scope, { status: 403 });

    if (err instanceof DirectoryError) {
      if (err.status === 401) {
        return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      }
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Microsoft Graph rate limit" },
          {
            status: 429,
            headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined,
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
