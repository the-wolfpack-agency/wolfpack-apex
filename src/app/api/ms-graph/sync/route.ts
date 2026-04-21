/**
 * POST /api/ms-graph/sync — run the MS Graph canonical-mirror sync for
 * the authenticated caller.
 *
 * Designed to be invoked by an external poller every 10 minutes per-user
 * (Vercel Cron, external scheduler, or another repo's workflow). No
 * internal setInterval — keeps the route stateless and reviewable.
 *
 * Per-user throttle: 1 run per 60 seconds so accidental double-invokes
 * don't hammer Graph's 429 budget. The underlying workers resume from
 * the stored deltaLink cursor so throttled calls lose no data.
 *
 * Response: 200 with SyncAllResult summary, including `failedEntityTypes`
 * for any worker that errored. 200 even on partial failure — the
 * dispatcher's whole point is that one worker's failure does not
 * cascade; the response lets the caller see which entity types
 * struggled so they can alert on `failedEntityTypes.length > 0`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { syncAllEntities } from "@/lib/ms-graph/sync";

const MIN_INTERVAL_MS = 60 * 1000;
const lastRun = new Map<string, number>();

export function _resetMsSyncThrottle(): void {
  lastRun.clear();
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const previous = lastRun.get(user.id);
  if (previous && now - previous < MIN_INTERVAL_MS) {
    const retryAfter = Math.ceil((MIN_INTERVAL_MS - (now - previous)) / 1000);
    return NextResponse.json(
      { error: "Sync already ran recently" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  lastRun.set(user.id, now);

  const summary = await syncAllEntities(user.id);
  return NextResponse.json(summary);
}
