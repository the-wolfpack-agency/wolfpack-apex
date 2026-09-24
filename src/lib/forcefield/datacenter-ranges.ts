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
