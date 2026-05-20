/**
 * GET /api/job-codes — list active job codes + cache freshness.
 *
 * The single read endpoint everyone calls: the /job-codes page,
 * the TimeLogWidget autocomplete, and any future surface that needs
 * the current code list. Cache-aware via `resolveJobCodes` so an
 * idle minute doesn't burn a Graph round-trip on every render, but
 * staleness triggers a transparent refresh.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { resolveJobCodes } from "@/lib/job-codes/resolver";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "jobcodes.view");
  if (!auth.ok) return auth.response;

  const t0 = Date.now();
  const result = await resolveJobCodes({
    triggeredBy: auth.user.id,
    refreshSource: "auto_stale",
  });

  await trackEvent("jobcodes.viewed", auth.user.id, auth.user.role, {
    row_count: result.rows.length,
    refreshed: result.refreshed,
    served_stale: result.servedStale,
    latency_ms: Date.now() - t0,
  });

  if (result.rows.length === 0 && result.refreshOutcome?.status === "failed") {
    return NextResponse.json(
      {
        error: "job_codes_unavailable",
        codes: [],
        source: result.source,
        refresh_error: result.refreshOutcome.error,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    codes: result.rows,
    source: result.source,
    served_stale: result.servedStale,
    refreshed_now: result.refreshed,
  });
}
