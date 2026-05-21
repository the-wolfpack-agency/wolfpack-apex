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
import { getLatestOrderedColumns } from "@/lib/job-codes/repo";

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

  /* Workbook column order, persisted on each successful refresh.
     Falls back to a JSONB-derived order when no refresh has stored
     an ordered list yet (older deploys). */
  const persistedOrder = await getLatestOrderedColumns();
  let columns: string[];
  if (persistedOrder && persistedOrder.length > 0) {
    columns = persistedOrder;
  } else {
    const extraColumns: string[] = [];
    const seen = new Set<string>();
    for (const r of result.rows) {
      for (const k of Object.keys(r.extra ?? {})) {
        if (!seen.has(k)) {
          seen.add(k);
          extraColumns.push(k);
        }
      }
    }
    columns = ["Code", "Description", ...extraColumns];
  }

  return NextResponse.json({
    codes: result.rows,
    columns,
    source: result.source,
    served_stale: result.servedStale,
    refreshed_now: result.refreshed,
  });
}
