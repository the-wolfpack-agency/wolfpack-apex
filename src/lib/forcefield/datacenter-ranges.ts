/**
 * Hosting classification - is a request coming from a datacenter (a cloud/hosting
 * provider) or a residential/consumer network? A "browser" arriving from AWS,
 * GCP, or Azure is almost certainly a bot, so this is one of the highest-signal
 * tells there is. It confirms the automation the behavioral layer only suspects.
 *
 * NON-PII: the IP is classified and then DISCARDED - only the label
 * ("datacenter" | "residential" | "unknown") is ever stored, never the address.
 *
 * ACCURACY BY SOURCE: the CIDR ranges are not hand-written; fetchDatacenterPrefixes
 * pulls the providers' OWN published range lists (AWS ip-ranges, GCP cloud.json,
 * Azure service tags), so coverage stays correct and current via the refresh cron.
 * classifyHosting is a pure, I/O-free bitmask check - safe on any hot path.
 */
export type Hosting = "datacenter" | "residential" | "unknown";

export interface DatacenterPrefix {
  /** IPv4 network as an integer. */
  base: number;
  /** Prefix length (e.g. 16 for a /16). */
  bits: number;
  provider: string;
}

/** Parse a dotted-quad IPv4 to a uint32, or null if not a valid IPv4. */
export function ipv4ToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/** Parse a "a.b.c.d/nn" CIDR into a normalized prefix, or null. */
export function parseCidr(cidr: string, provider = "cloud"): DatacenterPrefix | null {
  const [addr, bitsRaw] = cidr.split("/");
  const base = ipv4ToInt(addr ?? "");
  const bits = Number(bitsRaw);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits, provider };
}

/** True when the IP falls inside the prefix. */
export function ipInPrefix(ipInt: number, p: DatacenterPrefix): boolean {
  const mask = p.bits === 0 ? 0 : (0xffffffff << (32 - p.bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === p.base;
}

/**
 * Classify one IP against the datacenter prefix set. A valid IP inside any prefix
 * is "datacenter"; a valid IP in none is "residential"; a missing/invalid/IPv6
 * address is "unknown" (we never guess). O(n) over the prefixes - a few thousand
 * bitmask checks, microseconds.
 */
export function classifyHosting(ip: string | null | undefined, prefixes: readonly DatacenterPrefix[]): Hosting {
  if (!ip) return "unknown";
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return "unknown"; // IPv6 / malformed - not classified (never guessed)
  for (const p of prefixes) if (ipInPrefix(ipInt, p)) return "datacenter";
  return "residential";
}

/** A published range source: a URL and a parser that yields IPv4 CIDR strings. */
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
        const p = parseCidr(cidr, src.provider);
        if (p) out.push(p);
      }
    } catch {
      // skip this source this run
    }
  }
  return out;
}
