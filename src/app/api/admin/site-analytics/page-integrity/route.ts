/**
 * GET /api/admin/site-analytics/page-integrity?site=<label>
 *
 * Page integrity for one of OUR sites (weekendwithporsche, aidanmulready,
 * ogiam.com, ...): which origins its visitors' browsers saw the pages load that
 * the site never named, and whether any is new since the site's 7-day baseline.
 * The same report a client sees on its own dashboard (page-integrity.ts), scoped
 * by site label. Origins and counts only.
 *
 *   200 { integrity }
 *   400 { error: "site_required" } for a missing or malformed site label
 *   401 / 403 via requireCapability("analytics.view")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getPageIntegrity } from "@/lib/forcefield/page-integrity";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "analytics.view");
  if (!auth.ok) return auth.response;
  const site = new URL(req.url).searchParams.get("site") ?? "";
  if (!/^[a-z0-9._-]{1,64}$/.test(site)) return NextResponse.json({ error: "site_required" }, { status: 400 });
  const integrity = await getPageIntegrity(`site:${site}`);
  return NextResponse.json({ integrity });
}
