/**
 * POST /api/forcefield/canary/check
 *
 * PUBLIC: a site's sign-in handler asks, with its own ingest token, whether a
 * username is one of our planted canaries; never a user session.
 *
 * Body: { username, path?, sig?, fp?, site? }. The site sends ONLY usernames of
 * the canary shape (CANARY_LOGIN_RE), so real usernames never leave it. On a
 * match: the canary trip (event + audit + alert, canary-store.ts), a decoy-trip
 * site event carrying the canary's ORIGIN (which decoy, which session), and the
 * fingerprint auto-blocked. The site then refuses the sign-in exactly like a
 * wrong password, so the trap is never revealed.
 *
 *   200 { ok, canary } | 400 site_required | 401 unauthorized | 429 rate_limited
 */
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { canarySite } from "@/lib/forcefield/canary-site-auth";
import { reportCanarySignIn } from "@/lib/forcefield/canary-trip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const who = await canarySite(req.headers, body?.site);
  if ("error" in who) return NextResponse.json({ ok: false, error: who.error }, { status: who.error === "unauthorized" ? 401 : 400 });
  const rl = await checkRateLimit(`forcefield:canary-check:${who.key}`, { limit: 600, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  const canary = await reportCanarySignIn({ site: who.site, username: s(body?.username, 64), path: s(body?.path, 256), fp: s(body?.fp, 80), sig: s(body?.sig, 32) });
  return NextResponse.json({ ok: true, canary });
}
