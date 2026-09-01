/**
 * /api/qr/[id]/scans — per-scan attribution detail.
 *
 * Returns up to 500 fully-denormalized scan rows for a single code,
 * including the matched-client name (LEFT JOIN), the bot flag, UTMs,
 * lat/lng, postal, language, and the visitor hash so the dashboard
 * can group repeat scans by the same anonymous visitor.
 *
 * Auth-gated: only Wolfpack team members can see this — the underlying
 * data is our own, but it includes coarse geo + visitor fingerprints
 * that we don't expose publicly. Unauthenticated callers get 401.
 *
 * Each call emits `assistant.qr_scan_detail_viewed` so the team's usage
 * of this attribution view is itself attributable in the learning loop.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { listScans } from "@/lib/qr/scans";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "code id required" }, { status: 400 });
  }

  /* Optional ?limit= query, capped server-side to 500 by listScans. */
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 500)) : 500;

  const scans = await listScans(id, limit);

  trackEvent("assistant.qr_scan_detail_viewed", user.id, user.role, {
    code_id: id,
    returned: scans.length,
  });

  return NextResponse.json({ scans });
}
