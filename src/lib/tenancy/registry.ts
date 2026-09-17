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

/** Trim leading/trailing dashes without a regex (linear; no ReDoS surface). */
function trimDashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === "-") a++;
  while (b > a && s[b - 1] === "-") b--;
  return s.slice(a, b);
}

/**
 * Turn an org name into a valid tenant id slug (letter-led, suffixed to
 * disambiguate). Deliberately regex-free on the user-provided value: the input
 * is length-bounded first and the slug is built with a single linear pass, so a
 * hostile org name cannot drive polynomial backtracking (the ReDoS the code
 * gate flagged on the original ported version).
 */
export function tenantIdFor(orgName: string): string {
  const lower = (orgName ?? "").toLowerCase().slice(0, 64); // bound BEFORE any scan
  let slug = "";
  let prevDash = false;
  for (const ch of lower) {
    const alnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (alnum) {
      slug += ch;
      prevDash = false;
    } else if (!prevDash) {
      slug += "-";
      prevDash = true;
    }
  }
  const base = trimDashes(slug).slice(0, 30) || "tenant";
  const start = base[0] >= "a" && base[0] <= "z" ? base : `t-${base}`;
  const suffix = Math.abs(hash(orgName ?? "")).toString(36).slice(0, 4);
  return trimDashes(trimDashes(start).slice(0, 30) + "-" + suffix);
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
