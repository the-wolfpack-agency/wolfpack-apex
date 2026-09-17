/**
 * Control-plane tenant registry: the durable ledger of tenants for OGIAM
 * self-serve, hosted DB-per-tenant. One row per client with its status and
 * (encrypted) connection string to their OWN database. Request-time DB
 * resolution stays in the pure src/lib/db/tenant.ts (env-based "routed" mode);
 * this is the PROVISIONING record, written during signup and read by an admin
 * surface.
 *
 * Connection strings are encrypted at rest (AES-256-GCM via secret-storage) and
 * NEVER returned to a client - tenantConnectionString is server-side only.
 *
 * Ported from the proven wolfpack-ford self-serve stack, adapted to apex
 * conventions (query() + the existing isValidTenantId + encryptSecret).
 */
import { query } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import { isValidTenantId } from "@/lib/db/tenant";
import { trackEvent } from "@/lib/analytics";

export type TenantStatus = "pending_provision" | "active" | "offboarded";
export type TenantRow = {
  tenant_id: string;
  org_name: string;
  status: TenantStatus;
  has_db: boolean;
  admin_email: string | null;
  created_at: string;
}

/** Turn an org name into a valid tenant id slug (letter-led, suffixed to disambiguate). */
export function tenantIdFor(orgName: string): string {
  const base = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "tenant";
  const start = /^[a-z]/.test(base) ? base : `t-${base}`;
  return (start.replace(/-+$/g, "").slice(0, 30) + "-" + Math.abs(hash(orgName)).toString(36).slice(0, 4)).replace(/-+$/g, "");
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Record a new tenant (pending_provision). Idempotent on tenant_id. */
export async function registerTenant(input: {
  tenantId: string;
  orgName: string;
  adminEmail?: string | null;
  createdBy?: string | null;
}): Promise<boolean> {
  if (!isValidTenantId(input.tenantId) || !input.orgName.trim()) return false;
  try {
    await query(
      `INSERT INTO instinct_tenant_registry(tenant_id, org_name, status, admin_email, created_by)
       VALUES ($1,$2,'pending_provision',$3,$4)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [input.tenantId, input.orgName.trim(), input.adminEmail ?? null, input.createdBy ?? null],
    );
    // The admin email is intentionally NOT in analytics (PII); only that a tenant
    // was registered, so the self-serve funnel is measurable without leaking who.
    trackEvent("tenancy.tenant_registered", input.createdBy ?? "self-serve", "system", {
      tenant_id: input.tenantId,
    });
    return true;
  } catch {
    return false;
  }
}

/** Attach a database connection string to a tenant and mark it active. */
export async function setTenantConnection(tenantId: string, connectionString: string): Promise<boolean> {
  if (!isValidTenantId(tenantId) || !connectionString) return false;
  try {
    const res = await query(
      `UPDATE instinct_tenant_registry SET db_url_encrypted = $2, status = 'active', updated_at = now() WHERE tenant_id = $1`,
      [tenantId, encryptSecret(connectionString)],
    );
    if ((res.rowCount ?? 0) > 0) {
      trackEvent("tenancy.tenant_provisioned", "system", "system", { tenant_id: tenantId });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The decrypted connection string for a tenant, or null. SERVER-SIDE ONLY. */
export async function tenantConnectionString(tenantId: string): Promise<string | null> {
  try {
    const { rows } = await query<{ db_url_encrypted: string | null }>(
      "SELECT db_url_encrypted FROM instinct_tenant_registry WHERE tenant_id = $1",
      [tenantId],
    );
    const enc = rows[0]?.db_url_encrypted;
    return enc ? decryptSecret(enc) : null;
  } catch {
    return null;
  }
}

/** Registry listing for an admin surface. NEVER exposes the connection string. */
export async function listTenants(): Promise<TenantRow[]> {
  try {
    const { rows } = await query<TenantRow>(
      `SELECT tenant_id, org_name, status, (db_url_encrypted IS NOT NULL) AS has_db, admin_email, created_at::text AS created_at
         FROM instinct_tenant_registry ORDER BY created_at DESC`,
    );
    return rows;
  } catch {
    return [];
  }
}

export async function getTenant(tenantId: string): Promise<TenantRow | null> {
  try {
    const { rows } = await query<TenantRow>(
      `SELECT tenant_id, org_name, status, (db_url_encrypted IS NOT NULL) AS has_db, admin_email, created_at::text AS created_at
         FROM instinct_tenant_registry WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
