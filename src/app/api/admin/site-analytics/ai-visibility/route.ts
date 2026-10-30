/**
 * GET /api/admin/site-analytics/ai-visibility?site=<label>&days=30
 *
 * Which AI agents and search engines read one of OUR sites (the internal
 * properties that are not Forcefield tenants: weekendwithporsche, aidanmulready,
 * ogiam.com, instinct), what they read, how often, and whether each was really
 * the agent it claimed to be. Same report a client sees on its own dashboard
 * (ai-visibility.ts), scoped by site label. Counts only.
 *
 *   200 { visibility }
 *   400 { error: "site_required" } for a missing or malformed site label
 *   401 / 403 via requireCapability("analytics.view")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAiVisibility } from "@/lib/forcefield-web/ai-visibility";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "analytics.view");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const site = sp.get("site") ?? "";
  if (!/^[a-z0-9.\-_]{1,64}$/i.test(site)) return NextResponse.json({ error: "site_required" }, { status: 400 });
  const days = Number(sp.get("days") ?? 30);
  const visibility = await getAiVisibility({ site }, { days: Number.isFinite(days) ? days : 30 });
  return NextResponse.json({ visibility });
}
