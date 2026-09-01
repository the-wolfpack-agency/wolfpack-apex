/**
 * POST /api/job-codes/refresh — admin-only force resync from SharePoint.
 *
 * Bypasses the TTL cache and calls Graph immediately. Useful when
 * finance just updated the source workbook and wants Instinct to
 * reflect the change without waiting for the 15-min TTL.
 *
 * Rate-limited to one refresh per 30 seconds per user — the Graph
 * call is expensive (search + workbook usedRange) and the resulting
 * UPSERT touches every cache row.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { forceRefresh } from "@/lib/job-codes/resolver";

const REFRESH_COOLDOWN_MS = 30_000;
const recenterfreshes = new Map<string, number>();

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "jobcodes.refresh");
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const last = recenterfreshes.get(auth.user.id) ?? 0;
  if (now - last < REFRESH_COOLDOWN_MS) {
    const retryAfter = Math.ceil((REFRESH_COOLDOWN_MS - (now - last)) / 1000);
    return NextResponse.json(
      { error: "rate_limited", retry_after_sec: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  recenterfreshes.set(auth.user.id, now);

  const outcome = await forceRefresh(auth.user.id, "manual");

  await trackEvent("jobcodes.refresh_requested", auth.user.id, auth.user.role, {
    status: outcome.status,
    rows_seen: outcome.rowsSeen,
    rows_added: outcome.rowsAdded,
    rows_updated: outcome.rowsUpdated,
    rows_deactivated: outcome.rowsDeactivated,
    error_code: outcome.error?.code ?? "",
  });

  if (outcome.status === "failed") {
    return NextResponse.json(
      {
        ok: false,
        outcome,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, outcome });
}
