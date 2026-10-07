/**
 * Forcefield tenant registry - the multi-tenant foundation for self-serve.
 *
 * Each onboarded client is a tenant with its own ingest token. The client
 * presents the token from its adapter (Worker / middleware); we hash it, match it
 * to a tenant, and attribute the event. Tokens are stored HASHED (sha256), never
 * in the clear, so a database leak never yields a usable credential; the raw token
 * is returned exactly once, at creation, and is the caller's to deliver securely.
 *
 * This is the attribution + identity primitive. Scoping the dashboard queries to a
 * tenant and the self-serve sign-up UI build ON this; they are separate increments.
 */
import { createHash, randomBytes } from "node:crypto";
import { safeQuery } from "@/lib/db";

export interface ForcefieldTenant {
  id: string;
  name: string;
  siteLabel: string;
  status: "active" | "disabled";
  createdAt: string;
  /** Commercial state (optional; present on the admin listing). Decoupled from the
   *  ingest path - the hard entitlement kill is `status`. See billing.ts. */
  plan?: string;
  subscriptionStatus?: string;
  /** Participates in the shared threat-intel network (default true). Opaque
   *  attacker fingerprints only, never customer data. */
  sharesIntel?: boolean;
}

/** The ingest token a tenant presents. Prefixed so it is recognizable in a log or
 *  a config file as a Forcefield key, and long enough to be unguessable. */
export function generateTenantToken(): string {
  return `ff_${randomBytes(24).toString("base64url")}`;
}

/** The stored form of a token: a salted-by-nothing sha256 is sufficient because the
 *  token itself is high-entropy (not a password), so there is no dictionary to
 *  attack; hashing just means a DB leak is not a credential leak. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Injectable query fn so the registry is unit-testable without a database. */
export type TenantQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const liveQuery: TenantQuery = async (sql, params) => (await safeQuery(sql, params ?? [])).rows as never;

/** A valid tenant name/site is a short, non-empty label. */
function clean(v: string, max = 120): string {
  return v.trim().slice(0, max);
}

/**
 * Create a tenant and issue its ingest token. Returns the tenant plus the RAW
 * token - the ONLY time it is available in the clear. Stores the hash. Returns
 * null on invalid input or a write failure (never throws into the caller).
 */
export async function createForcefieldTenant(
  input: { name: string; siteLabel: string },
  q: TenantQuery = liveQuery,
): Promise<{ tenant: ForcefieldTenant; token: string } | null> {
  const name = clean(input.name);
  const siteLabel = clean(input.siteLabel);
  if (name.length < 2 || siteLabel.length < 2) return null;
  const token = generateTenantToken();
  try {
    const [row] = await q<{ id: string; name: string; site_label: string; status: string; created_at: string }>(
      `INSERT INTO forcefield_tenants (name, site_label, token_sha256)
       VALUES ($1, $2, $3)
       RETURNING id, name, site_label, status, created_at::text AS created_at`,
      [name, siteLabel, hashToken(token)],
    );
    if (!row) return null;
    return { tenant: rowToTenant(row), token };
  } catch {
    return null;
  }
}

/**
 * Resolve the ACTIVE tenant that owns a presented ingest token, or null. The
 * lookup is by token hash, so the raw token is never compared in the database.
 * A disabled or unknown token resolves to null (the ingest then falls through to
 * the shared-token path, never trusting an unverified tenant).
 */
export async function resolveTenantByToken(token: string, q: TenantQuery = liveQuery): Promise<ForcefieldTenant | null> {
  const t = token?.trim();
  if (!t) return null;
  try {
    const [row] = await q<{ id: string; name: string; site_label: string; status: string; created_at: string }>(
      `SELECT id, name, site_label, status, created_at::text AS created_at
         FROM forcefield_tenants
        WHERE token_sha256 = $1 AND status = 'active'
        LIMIT 1`,
      [hashToken(t)],
    );
    return row ? rowToTenant(row) : null;
  } catch {
    return null;
  }
}

/** Registry listing for an admin surface. NEVER returns the token or its hash. */
export async function listForcefieldTenants(q: TenantQuery = liveQuery): Promise<ForcefieldTenant[]> {
  try {
    const rows = await q<{ id: string; name: string; site_label: string; status: string; created_at: string; plan?: string; subscription_status?: string; shares_intel?: boolean }>(
      `SELECT id, name, site_label, status, created_at::text AS created_at, plan, subscription_status, shares_intel
         FROM forcefield_tenants ORDER BY created_at DESC`,
    );
    return rows.map(rowToTenant);
  } catch {
    return [];
  }
}

/**
 * Enable or disable a tenant. Disabling is how a leaked token is KILLED: a
 * disabled tenant's token resolves to null (resolveTenantByToken is active-only),
 * so the edge immediately falls through to the shared path and the token can no
 * longer attribute events or read stats. Reversible. Never throws.
 */
export async function setTenantStatus(
  id: string,
  status: "active" | "disabled",
  q: TenantQuery = liveQuery,
): Promise<boolean> {
  try {
    const rows = await q<{ id: string }>(
      `UPDATE forcefield_tenants SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, status],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Rotate a tenant's ingest token: issue a NEW token, replace the stored hash, and
 * return the new raw token ONCE (it is only ever stored hashed). The OLD token
 * stops resolving immediately. This is the response to a suspected compromise that
 * keeps the tenant + its history intact. Returns null on unknown id / write error.
 */
export async function rotateTenantToken(
  id: string,
  q: TenantQuery = liveQuery,
): Promise<{ token: string } | null> {
  const token = generateTenantToken();
  try {
    const rows = await q<{ id: string }>(
      `UPDATE forcefield_tenants SET token_sha256 = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, hashToken(token)],
    );
    return rows.length > 0 ? { token } : null;
  } catch {
    return null;
  }
}

/**
 * Set a tenant's participation in the shared threat-intel network. Opting out
 * means the tenant neither contributes caught-attacker fingerprints to, nor (when
 * the distributed list is enabled) consumes, the shared list. Never throws.
 */
export async function setTenantSharesIntel(
  id: string,
  shares: boolean,
  q: TenantQuery = liveQuery,
): Promise<boolean> {
  try {
    const rows = await q<{ id: string }>(
      `UPDATE forcefield_tenants SET shares_intel = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, shares],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

function rowToTenant(row: { id: string; name: string; site_label: string; status: string; created_at: string; plan?: string; subscription_status?: string; shares_intel?: boolean }): ForcefieldTenant {
  return {
    id: row.id,
    name: row.name,
    siteLabel: row.site_label,
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.created_at,
    // Present only on the admin listing (the other SELECTs omit them -> default none).
    plan: row.plan ?? "none",
    subscriptionStatus: row.subscription_status ?? "none",
    sharesIntel: row.shares_intel !== false,
  };
}
