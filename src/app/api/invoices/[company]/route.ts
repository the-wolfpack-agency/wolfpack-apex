/**
 * GET /api/invoices/{company} — read-only invoice tracker for one company.
 *   200 { tracker, company, sheet, columns, rows, source, ... }
 *   | 401 (no session) | 403 (not on the tracker's viewer allowlist) | 404.
 *
 * Access is an EXPLICIT per-tracker email allowlist (finance/budget data), NOT a
 * role capability — least privilege. Agent/on-behalf tokens resolve to an empty
 * email and are denied. Every view + every access denial is recorded to the
 * learning spine (invoice_tracker.viewed / .access_denied).
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getTracker, canViewTracker } from "@/lib/invoice-tracker/config";
import { resolveTracker } from "@/lib/invoice-tracker/resolver";
import { trackEvent } from "@/lib/analytics";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ company: string }> },
): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { company } = await params;
  const tracker = getTracker(company);
  if (!tracker) return NextResponse.json({ error: "unknown_tracker" }, { status: 404 });

  if (!canViewTracker(tracker, user.email)) {
    trackEvent("invoice_tracker.access_denied", user.id, user.role, { tracker: tracker.id });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await resolveTracker({ tracker, triggeredBy: user.id, triggeredByRole: user.role });
  trackEvent("invoice_tracker.viewed", user.id, user.role, {
    tracker: tracker.id,
    rows: result.rows.length,
    source: result.source,
    served_stale: result.servedStale,
  });

  return NextResponse.json({
    tracker: tracker.id,
    company: tracker.company,
    sheet: tracker.sheet,
    columns: result.columns,
    rows: result.rows,
    source: result.source,
    served_stale: result.servedStale,
    last_refreshed_at: result.lastRefreshedAt,
    web_url: result.webUrl,
    error_code: result.errorCode ?? null,
  });
}
