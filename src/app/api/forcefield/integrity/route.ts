/**
 * POST /api/forcefield/integrity
 *
 * PUBLIC: a protected site forwards its visitors' browser-side tamper reports
 * here with its own ingest token (forcefield-web/integrity.ts); never a user
 * session.
 *
 * Body, either form (site only with one of our shared tokens; a tenant's token
 * pins its own site):
 *   { site?, sig, reports: [{ directive, blockedOrigin, page }] }   a vendored
 *       site, already normalized (forcefield-web/integrity.ts);
 *   { site?, raw, client: { userAgent, headerNames } }               the WordPress
 *       plugin, which forwards the browser's report as is: normalized here with
 *       the same engine function, and the session signature derived here from
 *       the request shape the plugin already forwards to observe.
 * Every field is validated again here, so nothing but a directive, an origin, a
 * page path and a session signature can be stored.
 *
 *   200 { ok, stored } | 400 site_required | 401 unauthorized | 429 rate_limited
 */
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { canarySite } from "@/lib/forcefield/canary-site-auth";
import { recordIntegrityReports } from "@/lib/forcefield/page-integrity";
import { normalizeIntegrityReports } from "@/lib/forcefield-web/integrity";
import { clientKeys } from "@/lib/forcefield-web/observe";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { site?: unknown; sig?: unknown; reports?: unknown; raw?: unknown; client?: { userAgent?: unknown; headerNames?: unknown } } | null;
  const who = await canarySite(req.headers, body?.site);
  if ("error" in who) return NextResponse.json({ ok: false, error: who.error }, { status: who.error === "unauthorized" ? 401 : 400 });
  const rl = await checkRateLimit(`forcefield:integrity:${who.key}`, { limit: 1200, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  let sig = body?.sig;
  let reports = body?.reports;
  if (body?.raw !== undefined) {
    reports = normalizeIntegrityReports(body.raw);
    const ua = typeof body.client?.userAgent === "string" ? body.client.userAgent.slice(0, 512) : "";
    const names = Array.isArray(body.client?.headerNames) ? body.client.headerNames.filter((h): h is string => typeof h === "string").slice(0, 64) : [];
    sig = clientKeys({ userAgent: ua, country: "", headerNames: names, nowMs: Date.now() }, DEFAULT_RULESET).sig;
  }
  const stored = await recordIntegrityReports(who.key, sig, reports);
  return NextResponse.json({ ok: true, stored });
}
