/**
 * /api/admin/tenants - the control-plane operator view over the tenant registry.
 *
 *   GET  -> registered tenants (tenant id, org, status, has_db). NEVER the
 *           connection string.
 *   POST { tenantId, connectionString } -> attach a database to a pending tenant
 *           and mark it active. For the "provisioning is dark" default, this is
 *           how an operator finishes provisioning by hand. The connection string
 *           is encrypted at rest by the registry and is NEVER echoed back or
 *           logged.
 *
 * Capability: settings.manage_team (operator/control-plane surface). The attach
 * is a security-relevant mutation, so it is hash-chain audited - with only the
 * tenant id, never the connection string.
 *
 * Returns: 200 | 400 (bad body) | 401/403 (auth) | 404 (unknown tenant).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit } from "@/lib/audit-log";
import { listTenants, setTenantConnection, getTenant } from "@/lib/tenancy/registry";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const tenants = await listTenants();
  return NextResponse.json({ tenants });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { tenantId?: unknown; connectionString?: unknown };
  const tenantId = typeof b.tenantId === "string" ? b.tenantId.trim() : "";
  const connectionString = typeof b.connectionString === "string" ? b.connectionString.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  if (!connectionString) return NextResponse.json({ error: "connectionString is required" }, { status: 400 });

  if (!(await getTenant(tenantId))) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }

  const ok = await setTenantConnection(tenantId, connectionString);
  if (!ok) return NextResponse.json({ error: "could not attach the database" }, { status: 400 });

  // Security-relevant: record WHO attached a database to WHICH tenant - never the
  // connection string itself (it is a secret; only the fact + the tenant id).
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "tenancy.tenant_db_attached",
    resourceType: "tenant",
    resourceId: tenantId,
    afterState: { status: "active", has_db: true },
  });

  return NextResponse.json({ ok: true });
}
