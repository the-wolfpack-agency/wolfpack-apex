/**
 * Forcefield Edge - the tenant side (apex only, never vendored).
 *
 * A tenant on Edge has an origin (the owner's own server), a per-tenant origin
 * secret (sent to that origin as x-forcefield-edge on every forwarded request),
 * and one or more public hostnames served through the Edge Vercel project. This
 * module owns those records: write them from the admin console, and resolve one
 * hostname into the EdgeSite record the edge app caches.
 *
 * The origin secret is sealed at rest (secret-storage.ts, AES-256-GCM); the clear
 * value leaves this module only (a) to the admin who set the origin or rotated
 * the secret, once, so it can be configured on the origin, and (b) to the Edge
 * app through the service-token-gated site endpoint, which must send it. It is
 * never logged and never written to the audit trail or analytics.
 *
 * Every function takes an injectable query fn (unit tests run without a DB) and
 * never throws into the caller.
 */
import { randomBytes } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import { assertScannableUrl } from "@/lib/platform-scan/ssrf-guard";
import { isValidDomain } from "@/lib/sites-domain";
import { isLicensed, entitledToBlock, type SubscriptionStatus } from "./billing";
import { canonicalOrigin, normalizeEdgeHost, type EdgeSite } from "./gateway";

export type EdgeQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const liveQuery: EdgeQuery = async (sql, params) => (await safeQuery(sql, params ?? [])).rows as never;

/** The per-tenant origin secret: prefixed so it is recognizable in an origin's
 *  config as a Forcefield Edge value, 256 bits of entropy. */
export function generateEdgeSecret(): string {
  return `ffe_${randomBytes(32).toString("base64url")}`;
}

export type OriginCheck = { ok: true; origin: string } | { ok: false; reason: "invalid_origin" | "origin_not_public" };

/**
 * Validate an origin URL an admin entered. https only, scheme + host (+ port),
 * and the host must be PUBLIC: Edge fetches it from our infrastructure, so a
 * private, loopback, link-local or metadata address (or a public name that
 * resolves to one) would make the edge an SSRF relay. Reuses the platform-scan
 * SSRF guard (DNS-resolving) rather than a second copy of the rules.
 */
export async function validateEdgeOrigin(
  raw: unknown,
  check: (url: string) => Promise<void> = assertScannableUrl,
): Promise<OriginCheck> {
  const origin = canonicalOrigin(typeof raw === "string" ? raw.trim().replace(/\/+$/, "/") : raw);
  if (!origin) return { ok: false, reason: "invalid_origin" };
  try {
    await check(origin);
  } catch {
    return { ok: false, reason: "origin_not_public" };
  }
  return { ok: true, origin };
}

/** A hostname an owner may serve through Edge: a valid public DNS name, already
 *  normalized (lowercase, no port, no trailing dot). */
export function normalizeEdgeHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = normalizeEdgeHost(raw);
  return h && isValidDomain(h) ? h : null;
}

/**
 * Point a tenant at its origin. Issues the origin secret the first time (or when
 * `rotate`), sealed at rest; returns the CLEAR secret only when one was issued
 * by this call, so the caller can hand it to the owner once. Null on unknown /
 * disabled tenant or a write error.
 */
export async function setEdgeOrigin(
  tenantId: string,
  origin: string,
  opts: { rotate?: boolean } = {},
  q: EdgeQuery = liveQuery,
): Promise<{ origin: string; secret: string | null } | null> {
  try {
    const [row] = await q<{ edge_origin_secret_sealed: string | null }>(
      `SELECT edge_origin_secret_sealed FROM forcefield_tenants WHERE id = $1 AND status = 'active' LIMIT 1`,
      [tenantId],
    );
    if (!row) return null;
    const issue = opts.rotate === true || !row.edge_origin_secret_sealed;
    const secret = issue ? generateEdgeSecret() : null;
    const rows = issue
      ? await q<{ id: string }>(
          `UPDATE forcefield_tenants
              SET edge_origin_url = $2, edge_origin_secret_sealed = $3, edge_secret_rotated_at = now(), updated_at = now()
            WHERE id = $1 RETURNING id`,
          [tenantId, origin, encryptSecret(secret as string)],
        )
      : await q<{ id: string }>(
          `UPDATE forcefield_tenants SET edge_origin_url = $2, updated_at = now() WHERE id = $1 RETURNING id`,
          [tenantId, origin],
        );
    return rows.length > 0 ? { origin, secret } : null;
  } catch {
    return null;
  }
}

/** Issue a new origin secret (the old one stops being sent within the edge's
 *  cache TTL). Returns the clear value once, or null. */
export async function rotateEdgeSecret(tenantId: string, q: EdgeQuery = liveQuery): Promise<{ secret: string } | null> {
  try {
    const secret = generateEdgeSecret();
    const rows = await q<{ id: string }>(
      `UPDATE forcefield_tenants
          SET edge_origin_secret_sealed = $2, edge_secret_rotated_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'active' AND edge_origin_url IS NOT NULL RETURNING id`,
      [tenantId, encryptSecret(secret)],
    );
    return rows.length > 0 ? { secret } : null;
  } catch {
    return null;
  }
}

export type AddHostnameResult =
  | { ok: true; hostname: string; created: boolean }
  | { ok: false; error: "not_found" | "no_origin" | "hostname_in_use" | "write_failed" };

/**
 * Claim a hostname for a tenant. A hostname already held by ANOTHER tenant is
 * refused (the PRIMARY KEY is the guarantee; this checks first to give a clear
 * answer). Re-adding a hostname the tenant already holds is a no-op success.
 * The tenant must already have an origin, so a hostname never resolves to a
 * record Edge cannot forward.
 */
export async function addEdgeHostname(tenantId: string, hostname: string, q: EdgeQuery = liveQuery): Promise<AddHostnameResult> {
  try {
    const [t] = await q<{ edge_origin_url: string | null }>(
      `SELECT edge_origin_url FROM forcefield_tenants WHERE id = $1 AND status = 'active' LIMIT 1`,
      [tenantId],
    );
    if (!t) return { ok: false, error: "not_found" };
    if (!t.edge_origin_url) return { ok: false, error: "no_origin" };
    const [held] = await q<{ tenant_id: string }>(`SELECT tenant_id FROM forcefield_edge_hostnames WHERE hostname = $1 LIMIT 1`, [hostname]);
    if (held) {
      return held.tenant_id === tenantId ? { ok: true, hostname, created: false } : { ok: false, error: "hostname_in_use" };
    }
    const ins = await q<{ hostname: string }>(
      `INSERT INTO forcefield_edge_hostnames (hostname, tenant_id) VALUES ($1, $2)
       ON CONFLICT (hostname) DO NOTHING RETURNING hostname`,
      [hostname, tenantId],
    );
    // Lost a race to another tenant between the check and the insert.
    if (ins.length === 0) return { ok: false, error: "hostname_in_use" };
    return { ok: true, hostname, created: true };
  } catch {
    return { ok: false, error: "write_failed" };
  }
}

/** The DNS record an owner creates so the hostname reaches Edge. */
export interface EdgeDnsRecord {
  type: "CNAME" | "A" | "TXT";
  /** The record name relative to the zone ("edge-test", "@", "_vercel"). */
  name: string;
  value: string;
  /** Why the record exists ("route" sends traffic; "verify" proves ownership). */
  purpose: "route" | "verify";
}

/** Cache the latest verification state for the admin view. Best-effort. */
export async function recordHostnameStatus(
  tenantId: string,
  hostname: string,
  verified: boolean,
  records: EdgeDnsRecord[],
  q: EdgeQuery = liveQuery,
): Promise<boolean> {
  try {
    const rows = await q<{ hostname: string }>(
      `UPDATE forcefield_edge_hostnames SET verified = $3, dns_records = $4::jsonb, last_checked_at = now()
        WHERE hostname = $1 AND tenant_id = $2 RETURNING hostname`,
      [hostname, tenantId, verified, JSON.stringify(records)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface EdgeHostnameRow {
  hostname: string;
  verified: boolean;
  dnsRecords: EdgeDnsRecord[];
  lastCheckedAt: string | null;
}

/** The hostnames a tenant serves through Edge, for the admin view. */
export async function listEdgeHostnames(tenantId: string, q: EdgeQuery = liveQuery): Promise<EdgeHostnameRow[]> {
  try {
    const rows = await q<{ hostname: string; verified: boolean; dns_records: unknown; last_checked_at: string | null }>(
      `SELECT hostname, verified, dns_records, last_checked_at::text AS last_checked_at
         FROM forcefield_edge_hostnames WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows.map((r) => ({
      hostname: r.hostname,
      verified: r.verified === true,
      dnsRecords: Array.isArray(r.dns_records) ? (r.dns_records as EdgeDnsRecord[]) : [],
      lastCheckedAt: r.last_checked_at,
    }));
  } catch {
    return [];
  }
}

/** The tenant's Edge state for the admin view. NEVER includes the secret. */
export async function getEdgeTenantState(
  tenantId: string,
  q: EdgeQuery = liveQuery,
): Promise<{ originUrl: string | null; hasSecret: boolean; secretRotatedAt: string | null } | null> {
  try {
    const [row] = await q<{ edge_origin_url: string | null; has_secret: boolean; edge_secret_rotated_at: string | null }>(
      `SELECT edge_origin_url, (edge_origin_secret_sealed IS NOT NULL) AS has_secret, edge_secret_rotated_at::text AS edge_secret_rotated_at
         FROM forcefield_tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    if (!row) return null;
    return { originUrl: row.edge_origin_url, hasSecret: row.has_secret === true, secretRotatedAt: row.edge_secret_rotated_at };
  } catch {
    return null;
  }
}

interface EdgeSiteRow {
  tenant_id: string;
  site_label: string;
  platform: string | null;
  edge_origin_url: string | null;
  edge_origin_secret_sealed: string | null;
  enforce_enabled: boolean | null;
  subscription_status: string | null;
  current_period_end: string | null;
}

/**
 * Resolve one public hostname to the record the edge app needs, or null when
 * the hostname is not on Edge, its tenant is disabled, it has no origin, or its
 * secret cannot be opened (a record Edge cannot forward safely is not served).
 *
 * `enforce` is the tenant's console enforce toggle AND its block entitlement
 * (license), the same two gates the central observe route applies, so turning
 * blocking on is still a console action, never an edge env change.
 */
export async function resolveEdgeSiteByHost(host: string, q: EdgeQuery = liveQuery, nowMs: number = Date.now()): Promise<EdgeSite | null> {
  const hostname = normalizeEdgeHostname(host);
  if (!hostname) return null;
  try {
    const [r] = await q<EdgeSiteRow>(
      `SELECT t.id AS tenant_id, t.site_label, t.platform, t.edge_origin_url, t.edge_origin_secret_sealed,
              t.enforce_enabled, t.subscription_status, t.current_period_end::text AS current_period_end
         FROM forcefield_edge_hostnames h
         JOIN forcefield_tenants t ON t.id = h.tenant_id
        WHERE h.hostname = $1 AND t.status = 'active'
        LIMIT 1`,
      [hostname],
    );
    if (!r || !r.edge_origin_url || !r.edge_origin_secret_sealed) return null;
    const originUrl = canonicalOrigin(r.edge_origin_url);
    const originSecret = decryptSecret(r.edge_origin_secret_sealed);
    if (!originUrl || !originSecret) return null;
    const licensed = isLicensed(
      { status: (r.subscription_status ?? "none") as SubscriptionStatus, currentPeriodEnd: r.current_period_end },
      nowMs,
    );
    const site: EdgeSite = {
      tenantId: r.tenant_id,
      siteLabel: r.site_label,
      originUrl,
      originSecret,
      enforce: r.enforce_enabled === true && entitledToBlock(licensed),
    };
    if (r.platform) site.platform = r.platform;
    return site;
  } catch {
    return null;
  }
}

/** The ACTIVE tenant for an id, for the ingest's Edge path (site pinning). */
export async function resolveActiveTenantById(
  tenantId: string,
  q: EdgeQuery = liveQuery,
): Promise<{ id: string; siteLabel: string } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId ?? "")) return null;
  try {
    const [r] = await q<{ id: string; site_label: string }>(
      `SELECT id, site_label FROM forcefield_tenants WHERE id = $1 AND status = 'active' LIMIT 1`,
      [tenantId],
    );
    return r ? { id: r.id, siteLabel: r.site_label } : null;
  } catch {
    return null;
  }
}
