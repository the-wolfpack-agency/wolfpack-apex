/**
 * POST /api/invoices/{company}/refresh — force a live Graph re-pull of the
 * tracker's workbook, then return the fresh rows. Same allowlist gate as GET.
 * The pull uses the caller's delegated Microsoft token (cross-tenant reads need
 * it), so whoever refreshes must have SharePoint access to the source file.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getTracker, canViewTracker } from "@/lib/invoice-tracker/config";
import { resolveTracker } from "@/lib/invoice-tracker/resolver";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ company: string }> },
): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { company } = await params;
  const tracker = getTracker(company);
  if (!tracker) return NextResponse.json({ error: "unknown_tracker" }, { status: 404 });

  if (!canViewTracker(tracker, user.email)) {
    trackEvent("invoice_tracker.access_denied", user.id, user.role, { tracker: tracker.id, action: "refresh" });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await resolveTracker({
    tracker,
    triggeredBy: user.id,
    triggeredByRole: user.role,
    forceRefresh: true,
  });

  // A cold-cache refresh that couldn't reach Graph is a real failure the UI must
  // show (e.g. "connect your Microsoft account"), not a silent empty table.
  if (result.source === "empty") {
    return NextResponse.json(
      { error: "refresh_failed", error_code: result.errorCode ?? "unknown", tracker: tracker.id },
      { status: 502 },
    );
  }

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
