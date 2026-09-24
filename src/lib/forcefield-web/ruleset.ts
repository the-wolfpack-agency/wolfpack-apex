/**
 * Forcefield central ruleset - "update once, every site follows."
 *
 * A Forcefield-connected site runs a thin, stable edge shim. The VOLATILE part of
 * detection - which tools are scanners, which agents get the welcome lane, which
 * paths are traps - changes constantly as new scanners and crawlers appear. If
 * that lived in each site's code, adding a signature would mean editing and
 * redeploying N sites. Instead it lives HERE, served centrally, and each site
 * fetches + caches it. Update the ruleset once and every connected site reflects
 * it within the cache TTL, no per-site redeploy.
 *
 * Safety first: fetching is best-effort and FAIL-OPEN. Every site bundles
 * DEFAULT_RULESET, so if the central endpoint is slow, down, or returns garbage,
 * detection keeps working on the baked-in defaults - the central service can
 * never degrade a site. Pure + edge-safe apart from the single cached fetch.
 */
import { DEFAULT_TOOL_SIGNATURES, type ToolSignature } from "./fingerprint";
import type { KnownAgent } from "./classify";

export interface ForcefieldRuleset {
  /** Version marker so a site can log which ruleset it is running. */
  version: string;
  /** Allowlisted good agents (welcome lane). */
  knownAgents: KnownAgent[];
  /** Invisible honeypot paths - a request here is a scanner. */
  trapPaths: string[];
  /** Path prefixes that don't exist and are pure recon when requested
   *  (/wp-login.php, /.env, /.git, ...). */
  sensitivePaths: string[];
  /** Named tool signatures for the client fingerprint. */
  toolSignatures: ToolSignature[];
  /** Per-request fingerprints an administrator explicitly blocked from the
   *  board. Distributed here so a block made once turns the operator away on
   *  EVERY connected site (update-once). Only consulted when a site is in
   *  enforce mode; optional so an older ruleset without it still validates. */
  blockedFingerprints?: string[];
  /** Datacenter/cloud IPv4 prefixes ("base/bits") for hosting classification.
   *  Distributed here so the FULL provider range set (not just the bundled seed)
   *  reaches EVERY site at once and refreshes centrally - the united rollout: a
   *  coverage update ships to all client sites via one ruleset refresh, no
   *  re-vendor. Optional; a site with none falls back to its bundled seed. */
  datacenterPrefixes?: string[];
}

/** The bundled fallback baked into every site. Kept deliberately broad so a site
 *  running on defaults alone still detects the common cases. */
export const DEFAULT_RULESET: ForcefieldRuleset = {
  version: "bundled-1",
  knownAgents: [
    { id: "Googlebot", uaMatch: "Googlebot" },
    { id: "Bingbot", uaMatch: "bingbot" },
    { id: "GPTBot", uaMatch: "GPTBot" },
    { id: "OAI-SearchBot", uaMatch: "OAI-SearchBot" },
    { id: "ChatGPT-User", uaMatch: "ChatGPT-User" },
    { id: "ClaudeBot", uaMatch: "ClaudeBot" },
    { id: "PerplexityBot", uaMatch: "PerplexityBot" },
    { id: "Applebot", uaMatch: "Applebot" },
    { id: "DuckDuckBot", uaMatch: "DuckDuckBot" },
    { id: "Amazonbot", uaMatch: "Amazonbot" },
  ],
  trapPaths: ["/_ff/records"],
  sensitivePaths: [
    "/wp-login.php", "/xmlrpc.php", "/wp-admin", "/.env", "/.git", "/.git/config",
    "/config.json", "/backup", "/.aws/credentials", "/.ssh", "/phpmyadmin",
    "/admin.php", "/vendor/", "/.vscode", "/.DS_Store", "/server-status",
  ],
  toolSignatures: [...DEFAULT_TOOL_SIGNATURES],
  blockedFingerprints: [],
  datacenterPrefixes: [],
};

/** Validate + coerce an untrusted payload into a ruleset, or null if it is not
 *  shaped like one (so a malformed remote response fails open to the default
 *  rather than corrupting detection). */
export function coerceRuleset(data: unknown): ForcefieldRuleset | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const strArr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  // Strict: if ANY entry is malformed, treat the whole field as invalid so the
  // caller fails open to the bundled defaults rather than a half-parsed ruleset.
  const agents =
    Array.isArray(d.knownAgents) &&
    d.knownAgents.every((a) => !!a && typeof (a as KnownAgent).id === "string" && typeof (a as KnownAgent).uaMatch === "string")
      ? (d.knownAgents as KnownAgent[])
      : null;
  const traps = strArr(d.trapPaths);
  const sensitive = strArr(d.sensitivePaths);
  const sigs =
    Array.isArray(d.toolSignatures) &&
    d.toolSignatures.every((s) => Array.isArray(s) && s.length === 3 && s.every((x) => typeof x === "string"))
      ? (d.toolSignatures as ToolSignature[])
      : null;
  if (!agents || !traps || !sensitive || !sigs) return null;
  // Optional: absent or malformed -> empty (never blocks), so an older ruleset
  // still validates and a bad field can't accidentally enable enforcement.
  const blockedFingerprints = strArr(d.blockedFingerprints) ?? [];
  const datacenterPrefixes = strArr(d.datacenterPrefixes) ?? [];
  return {
    version: typeof d.version === "string" ? d.version : "remote",
    knownAgents: agents,
    trapPaths: traps,
    sensitivePaths: sensitive,
    toolSignatures: sigs,
    blockedFingerprints,
    datacenterPrefixes,
  };
}

// Module-level cache: one fetch per TTL per edge instance, not per request.
let _cache: { at: number; ruleset: ForcefieldRuleset } | null = null;

/** Test-only: clear the cache between cases. */
export function _resetRulesetCache(): void {
  _cache = null;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch the central ruleset, cached, FAIL-OPEN. Never throws and never blocks a
 * request: on any failure (network, non-200, malformed body) it returns the last
 * good cached ruleset, or the bundled DEFAULT_RULESET if there is none. Pass a URL
 * of "" to run purely on the bundled defaults.
 */
export async function fetchRuleset(
  url: string,
  opts: { nowMs?: number; ttlMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ForcefieldRuleset> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (_cache && nowMs - _cache.at < ttlMs) return _cache.ruleset;
  if (!url) return _cache?.ruleset ?? DEFAULT_RULESET;
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(url, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { ruleset?: unknown } | unknown;
      // Accept either the { ruleset } envelope the endpoint serves or a bare ruleset.
      const raw = body && typeof body === "object" && "ruleset" in body ? (body as { ruleset: unknown }).ruleset : body;
      const parsed = coerceRuleset(raw);
      if (parsed) {
        _cache = { at: nowMs, ruleset: parsed };
        return parsed;
      }
    }
  } catch {
    /* fail-open below */
  }
  return _cache?.ruleset ?? DEFAULT_RULESET;
}
