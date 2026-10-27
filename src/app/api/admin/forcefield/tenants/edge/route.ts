/**
 * POST /api/admin/forcefield/tenants/edge { id, action, origin?, hostname? }
 *
 * Console control for putting a tenant on Forcefield Edge (the one-DNS-record
 * full-protection upgrade):
 *
 *   action: "status"         -> the tenant's origin, whether a secret exists, and
 *                               each Edge hostname with its DNS record + state.
 *   action: "set_origin"     -> set the owner's server (https, public host only).
 *                               Issues the x-forcefield-edge secret the first time
 *                               and returns it ONCE so it can be set on the origin.
 *   action: "rotate_secret"  -> issue a new secret, returned ONCE.
 *   action: "add_hostname"   -> claim the hostname for the tenant and add it to the
 *                               Edge Vercel project; returns the DNS record the
 *                               owner must create and the verification state.
 *   action: "check_hostname" -> re-read the platform's verification + DNS state.
 *
 * Capability: settings.manage_team (same as the tenant lifecycle control). Every
 * change is audited; no audit row, analytics event or response other than the
 * one-time issue carries the secret, and the Vercel token never leaves the
 * provisioning module.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { httpStatusForCode } from "@/lib/sites-domain";
import {
  validateEdgeOrigin,
  setEdgeOrigin,
  rotateEdgeSecret,
  normalizeEdgeHostname,
  addEdgeHostname,
  listEdgeHostnames,
  getEdgeTenantState,
} from "@/lib/forcefield-web/edge-sites";
import { provisionEdgeHostname, checkEdgeHostname } from "@/lib/forcefield-web/edge-provision";
import { EDGE_ORIGIN_HEADER } from "@/lib/forcefield-web/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["status", "set_origin", "rotate_secret", "add_hostname", "check_hostname"] as const;
type Action = (typeof ACTIONS)[number];

/** What the owner's server must check, returned alongside a freshly issued secret. */
const ORIGIN_CONTRACT = {
  header: EDGE_ORIGIN_HEADER,
  rule: "Accept a request only when this header equals the secret (constant-time compare); reject everything else with 403.",
  publicHostHeader: "x-forwarded-host",
};

function provisionFailure(error: string, platformStatus: number): NextResponse {
  if (error === "not_configured") {
    return NextResponse.json(
      { ok: false, error: "edge_project_not_configured", detail: "FORCEFIELD_EDGE_VERCEL_PROJECT_ID, VERCEL_TOKEN_WOLFPACK_AGENCY and VERCEL_ORG_ID must be set" },
      { status: 503 },
    );
  }
  const status = httpStatusForCode(error as Parameters<typeof httpStatusForCode>[0]);
  return NextResponse.json({ ok: false, error: `vercel_${error}`, platformStatus }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown; origin?: unknown; hostname?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const action = String(body.action ?? "") as Action;
  if (!id || !ACTIONS.includes(action)) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const meta = extractRequestMetadata(req);
  const auditBase = {
    actor: { user_id: auth.user.id, role: auth.user.role },
    resourceType: "forcefield_tenant",
    resourceId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  };
  const track = (type: Parameters<typeof trackEvent>[0], props: Record<string, string | number | boolean>) =>
    void trackEvent(type, auth.user.id, auth.user.role, { tenantId: id, ...props });

  if (action === "status") {
    const state = await getEdgeTenantState(id);
    if (!state) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const hostnames = await listEdgeHostnames(id);
    return NextResponse.json({ ok: true, ...state, hostnames });
  }

  if (action === "set_origin") {
    const check = await validateEdgeOrigin(body.origin);
    if (!check.ok) return NextResponse.json({ ok: false, error: check.reason }, { status: 400 });
    const res = await setEdgeOrigin(id, check.origin);
    if (!res) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await recordAudit({ ...auditBase, action: "forcefield.edge_origin_set", afterState: { originUrl: res.origin, secretIssued: res.secret !== null } }).catch(() => {});
    track("forcefield.edge_origin_set", { secretIssued: res.secret !== null });
    return NextResponse.json({
      ok: true,
      originUrl: res.origin,
      ...(res.secret ? { originSecret: res.secret, originContract: ORIGIN_CONTRACT } : {}),
    });
  }

  if (action === "rotate_secret") {
    const res = await rotateEdgeSecret(id);
    if (!res) return NextResponse.json({ ok: false, error: "not_found_or_no_origin" }, { status: 404 });
    await recordAudit({ ...auditBase, action: "forcefield.edge_secret_rotated" }).catch(() => {});
    track("forcefield.edge_secret_rotated", {});
    return NextResponse.json({ ok: true, originSecret: res.secret, originContract: ORIGIN_CONTRACT });
  }

  const hostname = normalizeEdgeHostname(body.hostname);
  if (!hostname) return NextResponse.json({ ok: false, error: "invalid_hostname" }, { status: 400 });

  if (action === "add_hostname") {
    const claim = await addEdgeHostname(id, hostname);
    if (!claim.ok) {
      const status = claim.error === "not_found" ? 404 : claim.error === "write_failed" ? 500 : 409;
      return NextResponse.json({ ok: false, error: claim.error }, { status });
    }
    if (claim.created) {
      await recordAudit({ ...auditBase, action: "forcefield.edge_hostname_added", afterState: { hostname } }).catch(() => {});
    }
    const result = await provisionEdgeHostname(id, hostname);
    track("forcefield.edge_hostname_added", { hostname, created: claim.created, provisioned: result.ok, live: result.ok ? result.live : false });
    if (!result.ok) return provisionFailure(result.error, result.status);
    return NextResponse.json(result);
  }

  // check_hostname: only a hostname this tenant holds.
  const held = (await listEdgeHostnames(id)).some((h) => h.hostname === hostname);
  if (!held) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const result = await checkEdgeHostname(id, hostname);
  track("forcefield.edge_hostname_checked", { hostname, ok: result.ok, live: result.ok ? result.live : false });
  if (!result.ok) return provisionFailure(result.error, result.status);
  return NextResponse.json(result);
}
