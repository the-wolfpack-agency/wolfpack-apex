/**
 * GET /api/admin/forcefield/campaigns?site=<label>[&windowMinutes=N]
 *
 * "Campaigns in the wild": the multi-step detector run over a site's RECORDED
 * events, grouped per operator fingerprint. A stateless edge shim cannot see a
 * sequence; this reconstructs it after the fact from what was logged, so a site
 * like ogiam.com gets recon-breadth / kill-chain / id-enumeration / auth-abuse
 * coverage without per-operator state on its hot path.
 *
 * Read-only + capability-gated (settings.manage_team), same as the other Forcefield
 * admin routes. Never throws: the reader fails safe to an empty list, so the view
 * degrades to "no campaigns" rather than a 500.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { readOperatorCampaigns } from "@/lib/forcefield-web/campaign-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const site = (req.nextUrl.searchParams.get("site") || "ogiam.com").trim();
  const wmRaw = Number(req.nextUrl.searchParams.get("windowMinutes"));
  const windowMinutes = Number.isFinite(wmRaw) && wmRaw > 0 ? wmRaw : undefined;

  const campaigns = await readOperatorCampaigns(site, { windowMinutes });
  return NextResponse.json({ ok: true, site, count: campaigns.length, campaigns });
}
