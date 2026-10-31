/**
 * POST /api/forcefield/canary/mint
 *
 * PUBLIC: a site's middleware mints the fake sign-in it plants in a decoy, with
 * its own ingest token; never a user session.
 *
 * Body: { decoy: "<decoy path>", sig: "<session sig>", site?: "<label>" } (site
 * only with one of our shared tokens; a tenant's token pins its own site).
 * Idempotent per (site, decoy, session): the same canary comes back.
 *
 *   200 { ok, username, password } | 400 invalid_request / site_required
 *   401 unauthorized | 429 rate_limited | 503 unavailable
 */
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { canarySite } from "@/lib/forcefield/canary-site-auth";
import { mintCanaryLogin } from "@/lib/forcefield/canary-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { decoy?: unknown; sig?: unknown; site?: unknown } | null;
  const who = await canarySite(req.headers, body?.site);
  if ("error" in who) return NextResponse.json({ ok: false, error: who.error }, { status: who.error === "unauthorized" ? 401 : 400 });
  const decoy = typeof body?.decoy === "string" && body.decoy.startsWith("/") ? body.decoy.slice(0, 120) : "";
  const sig = typeof body?.sig === "string" && /^[a-z0-9:_-]{1,32}$/i.test(body.sig) ? body.sig : "";
  if (!decoy || !sig) return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  const rl = await checkRateLimit(`forcefield:canary-mint:${who.key}`, { limit: 600, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  const c = await mintCanaryLogin({ site: who.site, decoy, sig });
  if (!c) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true, ...c }, { headers: { "Cache-Control": "no-store" } });
}
