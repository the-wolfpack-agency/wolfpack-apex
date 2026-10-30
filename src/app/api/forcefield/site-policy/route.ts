/**
 * GET /api/forcefield/site-policy?site=<label>
 *
 * PUBLIC endpoint, authenticated by the SITE's own ingest token (x-ingest-token),
 * the same credential it already uses to send events (ingest-auth.ts): a tenant's
 * token returns that tenant's policy (the site parameter is ignored, a tenant can
 * never read another's); one of our shared tokens returns the policy of the named
 * internal site. The vendored engine fetches this and caches it for a few minutes.
 *
 *   200 { ok, blockedAgents }   (an unreadable policy is served as empty: fail-open)
 *   400 { error: "site_required" } shared token without a valid site label
 *   401 unknown / missing token
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveIngestCaller } from "@/lib/forcefield-web/ingest-auth";
import { EDGE_TENANT_HEADER } from "@/lib/forcefield-web/gateway";
import { getAgentPolicy, siteScope, tenantScope } from "@/lib/forcefield-web/agent-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveIngestCaller(req.headers.get("x-ingest-token") ?? "", req.headers.get(EDGE_TENANT_HEADER));
  if (!caller) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let scope;
  if (caller.kind === "tenant") scope = tenantScope(caller.tenant.id);
  else {
    const site = new URL(req.url).searchParams.get("site") ?? "";
    if (!/^[a-z0-9._-]{1,64}$/.test(site)) return NextResponse.json({ ok: false, error: "site_required" }, { status: 400 });
    scope = siteScope(site);
  }
  const policy = await getAgentPolicy(scope);
  return NextResponse.json({ ok: true, blockedAgents: policy.blockedAgents }, { headers: { "Cache-Control": "no-store" } });
}
