/**
 * Admin Forcefield tenant provisioning - the onboarding backend.
 *
 * POST { name, siteLabel } -> create a tenant + issue its ingest token. The raw
 *   token is returned ONCE here (it is only ever stored hashed); deliver it to the
 *   client, it cannot be recovered later.
 * GET -> list tenants (never returns a token).
 *
 * Capability: settings.manage_team. The self-serve sign-up UI will call this; for
 * the pilot an operator provisions a client here.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { createForcefieldTenant, listForcefieldTenants } from "@/lib/forcefield-web/tenants";
import { buildTenantQuickstart } from "@/lib/forcefield-web/tenant-quickstart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ tenants: await listForcefieldTenants() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; siteLabel?: unknown };
  const created = await createForcefieldTenant({
    name: String(body.name ?? ""),
    siteLabel: String(body.siteLabel ?? ""),
  });
  if (!created) return NextResponse.json({ ok: false, error: "invalid_name_or_site" }, { status: 400 });
  // Audit the credential issuance (who provisioned which tenant) - NEVER the token.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.tenant_provisioned",
    resourceType: "forcefield_tenant",
    resourceId: created.tenant.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: { name: created.tenant.name, siteLabel: created.tenant.siteLabel },
  }).catch(() => {});
  // The token + quick-start are returned exactly once; the token is stored only as
  // a hash, so this is the one chance to copy the client's ready-to-paste config.
  const quickstart = buildTenantQuickstart(created.tenant, created.token);
  return NextResponse.json({ ok: true, tenant: created.tenant, token: created.token, quickstart }, { status: 201 });
}
