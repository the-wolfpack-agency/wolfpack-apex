/**
 * Operator review of Forcefield signup requests - the GATE behind public signup.
 *
 * GET  -> list requests (default: pending). Never returns a token.
 * POST { id, action: "approve" | "reject" }
 *   approve -> provisions a tenant + issues its ingest token, returned ONCE here
 *              (deliver it to the client; it is stored only hashed).
 *   reject  -> closes the request.
 *
 * Capability: settings.manage_team (same as tenant provisioning). Every decision
 * is audited; the audit NEVER carries the token.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { buildTenantQuickstart } from "@/lib/forcefield-web/tenant-quickstart";
import {
  listSignupRequests,
  approveSignupRequest,
  rejectSignupRequest,
  type SignupRequest,
} from "@/lib/forcefield-web/signup";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const statusParam = req.nextUrl.searchParams.get("status");
  const status = (["pending", "approved", "rejected"] as const).includes(statusParam as SignupRequest["status"])
    ? (statusParam as SignupRequest["status"])
    : "pending";
  return NextResponse.json({ requests: await listSignupRequests(status) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
  const id = String(body.id ?? "");
  const action = String(body.action ?? "");
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const meta = extractRequestMetadata(req);

  if (action === "reject") {
    const res = await rejectSignupRequest(id, auth.user.id);
    if (!res.ok) {
      const status = res.reason === "not_found" ? 404 : res.reason === "already_reviewed" ? 409 : 500;
      return NextResponse.json({ ok: false, error: res.reason }, { status });
    }
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "forcefield.signup_rejected",
      resourceType: "forcefield_signup_request",
      resourceId: id,
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    }).catch(() => {});
    void trackEvent("forcefield.signup_rejected", auth.user.id, auth.user.role, { requestId: id });
    return NextResponse.json({ ok: true });
  }

  // approve
  const res = await approveSignupRequest(id, auth.user.id);
  if (!res.ok || !res.tenant || !res.token) {
    const status =
      res.reason === "not_found" ? 404 : res.reason === "already_reviewed" ? 409 : res.reason === "provision_failed" ? 422 : 500;
    return NextResponse.json({ ok: false, error: res.reason }, { status });
  }
  // Audit the credential issuance (who approved which request -> which tenant) - NEVER the token.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.signup_approved",
    resourceType: "forcefield_signup_request",
    resourceId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { tenantId: res.tenant.id, siteLabel: res.tenant.siteLabel },
  }).catch(() => {});
  void trackEvent("forcefield.signup_approved", auth.user.id, auth.user.role, { requestId: id, tenantId: res.tenant.id });

  const quickstart = buildTenantQuickstart(res.tenant, res.token);
  return NextResponse.json({ ok: true, tenant: res.tenant, token: res.token, quickstart }, { status: 201 });
}
