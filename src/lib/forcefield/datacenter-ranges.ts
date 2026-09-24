/**
 * Datacenter range FETCHING (server-side). The pure classifier (classifyHosting,
 * parseCidr, ...) lives in the PORTABLE edge core - @/lib/forcefield-web/hosting -
 * and is the single source of that logic (DRY); this module only pulls the
 * providers' OWN published range lists so accuracy comes from the source, not
 * hand-written CIDRs, and a refresh keeps the edge seed current.
 */
import { parseCidr, type DatacenterPrefix } from "@/lib/forcefield-web/hosting";

interface RangeSource {
  provider: string;
  url: string;
  extract: (json: unknown) => string[];
}

const SOURCES: RangeSource[] = [
  {
    provider: "aws",
    url: "https://ip-ranges.amazonaws.com/ip-ranges.json",
    extract: (j) => {
      const p = (j as { prefixes?: Array<{ ip_prefix?: string }> }).prefixes ?? [];
      return p.map((x) => x.ip_prefix ?? "").filter(Boolean);
    },
  },
  {
    provider: "gcp",
    url: "https://www.gstatic.com/ipranges/cloud.json",
    extract: (j) => {
      const p = (j as { prefixes?: Array<{ ipv4Prefix?: string }> }).prefixes ?? [];
      return p.map((x) => x.ipv4Prefix ?? "").filter(Boolean);
    },
  },
  {
    // goog.json is Google's SUPERSET (all Google, incl. Compute Engine external
    // ranges like 34.64.0.0/10 that cloud.json omits) - the accurate GCP coverage.
    provider: "google",
    url: "https://www.gstatic.com/ipranges/goog.json",
    extract: (j) => {
      const p = (j as { prefixes?: Array<{ ipv4Prefix?: string }> }).prefixes ?? [];
      return p.map((x) => x.ipv4Prefix ?? "").filter(Boolean);
    },
  },
];

/**
 * Fetch the providers' OWN published IPv4 ranges. Best-effort per source (a
 * source that fails is skipped, not fatal), so a transient outage never wipes the
 * set. Returns normalized prefixes for storage. Node/cron only.
 */
export async function fetchDatacenterPrefixes(): Promise<DatacenterPrefix[]> {
  const out: DatacenterPrefix[] = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const json = await res.json();
      for (const cidr of src.extract(json)) {
        const p = parseCidr(cidr);
        if (p) out.push(p);
      }
    } catch {
      // skip this source this run
    }
  }
  return out;
}

/** Read the distributed prefix set (compact "base/bits") for the ruleset. Empty
 *  on any error / no DB, so the ruleset simply omits them and sites use the seed. */
export async function getDatacenterPrefixes(): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<{ prefix: string }>(`SELECT prefix FROM instinct_datacenter_prefixes`);
    return rows.map((r) => r.prefix);
  } catch {
    return [];
  }
}

/** Refresh the stored prefix set from the providers' published lists (cron).
 *  Replaces the table transactionally so a mid-refresh read never sees a partial
 *  set. Returns the count written (0 if the fetch yielded nothing - the OLD set
 *  is kept rather than wiped). */
export async function refreshDatacenterPrefixes(): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  const prefixes = await fetchDatacenterPrefixes();
  if (prefixes.length === 0) return 0; // keep the existing set rather than wipe on a failed fetch
  const { query } = await import("@/lib/db");
  const values = prefixes.map((p) => `${p.base >>> 0}/${p.bits}`);
  try {
    await query("BEGIN");
    await query(`DELETE FROM instinct_datacenter_prefixes`);
    // Bulk insert in one statement.
    await query(
      `INSERT INTO instinct_datacenter_prefixes (prefix) SELECT unnest($1::text[]) ON CONFLICT (prefix) DO NOTHING`,
      [values],
    );
    await query("COMMIT");
    return values.length;
  } catch (err) {
    try { await query("ROLLBACK"); } catch { /* ignore */ }
    console.warn("[datacenter-ranges] refresh failed:", (err as Error).message);
    return 0;
  }
}
