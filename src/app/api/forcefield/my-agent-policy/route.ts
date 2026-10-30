/**
 * The client's own AI agent policy: which AI TRAINING crawlers their site turns
 * away (agent-policy.ts). Authorized by the tenant credential (x-forcefield-token,
 * the ingest token or a dashboard session), same posture as my-stats and
 * alert-email: a request can only ever read or change its own tenant.
 *
 * GET -> 200 { ok, blockedAgents, choices, updatedAt } | 401
 * PUT { blockedAgents: string[] } -> 200 { ok, blockedAgents }
 *     | 400 invalid_request / not_a_training_agent | 401 | 503
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { resolveTenantCredential } from "@/lib/forcefield-web/dashboard-session";
import { AI_TRAINING_AGENTS, getAgentPolicy, setAgentPolicy, tenantScope, validateBlockedAgents } from "@/lib/forcefield-web/agent-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const tenant = (await resolveTenantCredential(req.headers.get("x-forcefield-token") ?? ""))?.tenant;
  if (!tenant) return unauthorized();
  const p = await getAgentPolicy(tenantScope(tenant.id));
  return NextResponse.json({ ok: true, blockedAgents: p.blockedAgents, choices: AI_TRAINING_AGENTS, updatedAt: p.updatedAt }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const tenant = (await resolveTenantCredential(req.headers.get("x-forcefield-token") ?? ""))?.tenant;
  if (!tenant) return unauthorized();
  const body = (await req.json().catch(() => null)) as { blockedAgents?: unknown } | null;
  const v = validateBlockedAgents(body?.blockedAgents);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  const actor = `forcefield_tenant:${tenant.id}`;
  const r = await setAgentPolicy(tenantScope(tenant.id), v.agents, actor);
  if (!r.ok) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: actor, role: "tenant" },
    action: "forcefield.agent_policy_changed",
    resourceType: "forcefield_tenant",
    resourceId: tenant.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    beforeState: { blockedAgents: r.previous },
    afterState: { blockedAgents: v.agents },
  }).catch(() => {});
  void trackEvent("forcefield.agent_policy_changed", actor, "tenant", { tenantId: tenant.id, blocked: v.agents.join(","), count: v.agents.length });
  return NextResponse.json({ ok: true, blockedAgents: v.agents });
}
