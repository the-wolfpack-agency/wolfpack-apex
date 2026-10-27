/**
 * The server inventory the Forcefield WordPress plugin reports (PHP version,
 * WordPress version, active plugins with versions, web server software), and
 * what Forcefield does with it:
 *
 *   1. validate it strictly (only those fields, bounded sizes; anything else
 *      is refused, so no other site data can ride along);
 *   2. keep the latest one per tenant (forcefield_server_inventory, migration
 *      302);
 *   3. match it against the fixed-version data (server-exposure.ts);
 *   4. when a NEW exposure appears, email the tenant's CONFIRMED alert address
 *      once, through the one guarded tenant sender (sendForcefieldTenantMail:
 *      the build-phase recipient allowlist applies). The alert is claimed
 *      before it is sent and released if it is not delivered, so a later
 *      report retries and two concurrent reports never send twice.
 *
 * Injectable deps; never throws.
 */
import { query } from "@/lib/db";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";
import type { TenantQuery } from "@/lib/forcefield-web/tenants";
import { getNotifyState, mintUnsubscribeToken, type NotifyState } from "@/lib/forcefield-web/tenant-notify";
import { sendForcefieldTenantMail, type TenantMail, type TenantMailResult } from "@/lib/forcefield-web/tenant-mail";
import { renderExposureEmail } from "@/lib/forcefield-web/tenant-email";
import { buildExposureReport, exposureKeys, type ServerExposureReport, type ServerFinding, type ServerInventory } from "@/lib/forcefield-web/server-exposure";

export const MAX_PLUGINS = 300;
const VERSION_MAX = 40;
const SERVER_SOFTWARE_MAX = 120;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const ALLOWED_KEYS = new Set(["phpVersion", "wordpressVersion", "serverSoftware", "plugins", "pluginVersion"]);

export type InventoryValidation = { ok: true; inventory: ServerInventory } | { ok: false; error: string };

const optString = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length > max) return undefined;
  // Printable text only: no control characters.
  if (/[\u0000-\u001f\u007f]/.test(t)) return undefined;
  return t || null;
};

/** Validate the plugin's payload. Refuses unknown fields, wrong types and oversize values. */
export function validateInventory(raw: unknown): InventoryValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not_an_object" };
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length) return { ok: false, error: "unknown_field" };
  const phpVersion = optString(o.phpVersion, VERSION_MAX);
  const wordpressVersion = optString(o.wordpressVersion, VERSION_MAX);
  const serverSoftware = optString(o.serverSoftware, SERVER_SOFTWARE_MAX);
  const pluginVersion = optString(o.pluginVersion, VERSION_MAX);
  if (phpVersion === undefined) return { ok: false, error: "bad_php_version" };
  if (wordpressVersion === undefined) return { ok: false, error: "bad_wordpress_version" };
  if (serverSoftware === undefined) return { ok: false, error: "bad_server_software" };
  if (pluginVersion === undefined) return { ok: false, error: "bad_plugin_version" };
  if (!phpVersion && !wordpressVersion) return { ok: false, error: "empty_inventory" };
  const list = o.plugins ?? [];
  if (!Array.isArray(list) || list.length > MAX_PLUGINS) return { ok: false, error: "bad_plugins" };
  const plugins: ServerInventory["plugins"] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "bad_plugins" };
    const e = p as Record<string, unknown>;
    if (Object.keys(e).some((k) => k !== "slug" && k !== "version")) return { ok: false, error: "bad_plugins" };
    if (typeof e.slug !== "string" || !SLUG_RE.test(e.slug)) return { ok: false, error: "bad_plugins" };
    const version = optString(e.version, VERSION_MAX);
    if (version === undefined) return { ok: false, error: "bad_plugins" };
    const slug = e.slug.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    plugins.push({ slug, version });
  }
  plugins.sort((a, b) => a.slug.localeCompare(b.slug));
  return { ok: true, inventory: { phpVersion, wordpressVersion, serverSoftware, plugins, pluginVersion } };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const liveQuery: TenantQuery = async (sql, params) => (await query(sql, params ?? [])).rows as never;

interface InventoryRow {
  php_version: string | null;
  wordpress_version: string | null;
  server_software: string | null;
  plugins: { slug: string; version: string | null }[] | string;
  plugin_version: string | null;
  alerted_keys: string[] | null;
  reports: number;
  first_received_at: string;
  received_at: string;
}

/**
 * Upsert the latest inventory. alerted_keys is pruned to the exposures still
 * present (so a fixed-then-reappearing flaw alerts again). Returns the pruned
 * alerted keys.
 */
export const UPSERT_INVENTORY_SQL = `
  INSERT INTO forcefield_server_inventory
    (tenant_id, php_version, wordpress_version, server_software, plugins, plugin_version, alerted_keys)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, '{}')
  ON CONFLICT (tenant_id) DO UPDATE SET
    php_version = EXCLUDED.php_version,
    wordpress_version = EXCLUDED.wordpress_version,
    server_software = EXCLUDED.server_software,
    plugins = EXCLUDED.plugins,
    plugin_version = EXCLUDED.plugin_version,
    alerted_keys = ARRAY(SELECT k FROM unnest(forcefield_server_inventory.alerted_keys) AS k WHERE k = ANY($7::text[]) ORDER BY k),
    reports = forcefield_server_inventory.reports + 1,
    received_at = now()
  RETURNING alerted_keys, reports`;

/** Claim the not-yet-alerted keys atomically. Returns the keys this call owns. */
export const CLAIM_ALERT_SQL = `
  UPDATE forcefield_server_inventory
     SET alerted_keys = ARRAY(SELECT DISTINCT k FROM unnest(alerted_keys || $2::text[]) AS k ORDER BY k)
   WHERE tenant_id = $1 AND NOT (alerted_keys && $2::text[])
  RETURNING tenant_id`;

export const RELEASE_ALERT_SQL = `
  UPDATE forcefield_server_inventory
     SET alerted_keys = ARRAY(SELECT k FROM unnest(alerted_keys) AS k WHERE NOT (k = ANY($2::text[])) ORDER BY k)
   WHERE tenant_id = $1`;

export const READ_INVENTORY_SQL = `
  SELECT php_version, wordpress_version, server_software, plugins, plugin_version, alerted_keys, reports,
         first_received_at::text AS first_received_at, received_at::text AS received_at
    FROM forcefield_server_inventory WHERE tenant_id = $1`;

export interface StoredInventory {
  inventory: ServerInventory;
  reports: number;
  firstReceivedAt: string;
  receivedAt: string;
}

function rowToInventory(r: InventoryRow): StoredInventory {
  const plugins: unknown = typeof r.plugins === "string" ? JSON.parse(r.plugins) : r.plugins;
  return {
    inventory: {
      phpVersion: r.php_version,
      wordpressVersion: r.wordpress_version,
      serverSoftware: r.server_software,
      plugins: Array.isArray(plugins) ? (plugins as ServerInventory["plugins"]) : [],
      pluginVersion: r.plugin_version,
    },
    reports: Number(r.reports) || 0,
    firstReceivedAt: r.first_received_at,
    receivedAt: r.received_at,
  };
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export interface InventoryDeps {
  q?: TenantQuery;
  notifyState?: (tenantId: string) => Promise<NotifyState | null>;
  send?: (mail: TenantMail) => Promise<TenantMailResult>;
  baseUrl?: string;
  unsubscribeToken?: (tenantId: string, email: string) => string;
}

export type ReceiveReason = "ok" | "invalid" | "error";

export interface ReceiveResult {
  ok: boolean;
  reason: ReceiveReason;
  error?: string;
  report?: ServerExposureReport;
  inventory?: ServerInventory;
  /** Exposures that appeared on this report (not alerted before). */
  newExposures?: ServerFinding[];
  /** "sent" | "not_confirmed" | "not_delivered:<reason>" | "already_claimed" | "none". */
  alert?: string;
}

export async function receiveServerInventory(
  tenant: { id: string; siteLabel: string },
  raw: unknown,
  deps: InventoryDeps = {},
): Promise<ReceiveResult> {
  const v = validateInventory(raw);
  if (!v.ok) return { ok: false, reason: "invalid", error: v.error };
  const q = deps.q ?? liveQuery;
  const report = buildExposureReport(v.inventory);
  const current = exposureKeys(report);
  let alerted: string[] = [];
  try {
    const [row] = await q<{ alerted_keys: string[] | null }>(UPSERT_INVENTORY_SQL, [
      tenant.id,
      v.inventory.phpVersion,
      v.inventory.wordpressVersion,
      v.inventory.serverSoftware,
      JSON.stringify(v.inventory.plugins),
      v.inventory.pluginVersion ?? null,
      current,
    ]);
    alerted = row?.alerted_keys ?? [];
  } catch {
    return { ok: false, reason: "error" };
  }
  const fresh = current.filter((k) => !alerted.includes(k));
  const newExposures = report.findings.filter((f) => fresh.includes(f.key));
  const inventory = v.inventory;
  if (newExposures.length === 0) return { ok: true, reason: "ok", report, inventory, newExposures, alert: "none" };
  const alert = await alertNewExposures(tenant, newExposures, q, deps);
  return { ok: true, reason: "ok", report, inventory, newExposures, alert };
}

async function alertNewExposures(tenant: { id: string; siteLabel: string }, findings: ServerFinding[], q: TenantQuery, deps: InventoryDeps): Promise<string> {
  try {
    const notify = await (deps.notifyState ?? ((id: string) => getNotifyState(id)))(tenant.id);
    if (!notify || notify.status !== "confirmed" || !notify.email) return "not_confirmed";
    const keys = findings.map((f) => f.key);
    const claimed = await q(CLAIM_ALERT_SQL, [tenant.id, keys]);
    if (claimed.length === 0) return "already_claimed";
    const baseUrl = deps.baseUrl ?? instinctPublicBaseUrl();
    const token = (deps.unsubscribeToken ?? mintUnsubscribeToken)(tenant.id, notify.email);
    const mail = renderExposureEmail({ site: tenant.siteLabel, to: notify.email, findings, baseUrl, unsubscribeToken: token });
    const res = await (deps.send ?? sendForcefieldTenantMail)({ to: notify.email, subject: mail.subject, text: mail.text, html: mail.html, purpose: "exposure", tenantId: tenant.id });
    if (!res.delivered) {
      await q(RELEASE_ALERT_SQL, [tenant.id, keys]).catch(() => undefined);
      return `not_delivered:${res.reason}`;
    }
    return "sent";
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Read (the dashboard)
// ---------------------------------------------------------------------------

export interface ExposureView {
  /** null until the plugin has reported once. */
  report: (ServerExposureReport & {
    phpVersion: string | null;
    wordpressVersion: string | null;
    receivedAt: string;
    firstReceivedAt: string;
  }) | null;
}

/** The tenant's latest report, computed on read. null = the read failed. */
export async function getServerExposure(tenantId: string, deps: Pick<InventoryDeps, "q"> = {}): Promise<ExposureView | null> {
  try {
    const [row] = await (deps.q ?? liveQuery)<InventoryRow>(READ_INVENTORY_SQL, [tenantId]);
    if (!row) return { report: null };
    const stored = rowToInventory(row);
    const report = buildExposureReport(stored.inventory);
    return {
      report: {
        ...report,
        phpVersion: stored.inventory.phpVersion,
        wordpressVersion: stored.inventory.wordpressVersion,
        receivedAt: stored.receivedAt,
        firstReceivedAt: stored.firstReceivedAt,
      },
    };
  } catch {
    return null;
  }
}
