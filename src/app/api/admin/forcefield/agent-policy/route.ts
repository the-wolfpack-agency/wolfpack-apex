/**
 * The AI agent policy for one of OUR sites (the internal properties that are not
 * Forcefield tenants): which AI TRAINING crawlers it turns away (agent-policy.ts).
 *
 * GET ?site=<label>                     -> 200 { blockedAgents, choices, updatedAt, canEdit }
 * PUT ?site=<label> { blockedAgents }   -> 200 { blockedAgents }
 *   400 site_required / invalid_request / not_a_training_agent | 503
 *   401 / 403 via requireCapability: read analytics.view, change settings.manage_team
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { AI_TRAINING_AGENTS, getAgentPolicy, setAgentPolicy, siteScope, validateBlockedAgents } from "@/lib/forcefield-web/agent-policy";

const siteOf = (req: NextRequest) => {
  const s = new URL(req.url).searchParams.get("site") ?? "";
  return /^[a-z0-9._-]{1,64}$/.test(s) ? s : null;
};

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "analytics.view");
  if (!auth.ok) return auth.response;
  const site = siteOf(req);
  if (!site) return NextResponse.json({ error: "site_required" }, { status: 400 });
  const p = await getAgentPolicy(siteScope(site));
  // Tell the client whether the caller may change it, so a viewer never sees a
  // control that would 403.
  return NextResponse.json({ blockedAgents: p.blockedAgents, choices: AI_TRAINING_AGENTS, updatedAt: p.updatedAt, canEdit: auth.capabilities.has("settings.manage_team") });
}

export async function PUT(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const site = siteOf(req);
  if (!site) return NextResponse.json({ error: "site_required" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { blockedAgents?: unknown } | null;
  const v = validateBlockedAgents(body?.blockedAgents);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const r = await setAgentPolicy(siteScope(site), v.agents, auth.user.id);
  if (!r.ok) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.agent_policy_changed",
    resourceType: "forcefield_site",
    resourceId: site,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    beforeState: { blockedAgents: r.previous },
    afterState: { blockedAgents: v.agents },
  }).catch(() => {});
  void trackEvent("forcefield.agent_policy_changed", auth.user.id, auth.user.role, { site, blocked: v.agents.join(","), count: v.agents.length });
  return NextResponse.json({ blockedAgents: v.agents });
}
