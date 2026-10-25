/**
 * Forcefield AUTOMATIC block scope - may an automatic block be fingerprint-wide?
 *
 * An operator fingerprint is `${headerSignature}:${kind}` (see
 * forcefield-web/fingerprint.ts operatorFingerprint): the header-name shape plus
 * the tool name or client type. It carries NO network component. For a default
 * client (curl, python-requests, Go, a headless browser, a crawler) the header
 * shape is the library's default, so every unrelated user of that tool produces
 * the SAME fingerprint. Distributing an automatic block on such a fingerprint
 * turns away every user of the tool on every connected site: on 2026-10-25 one
 * honeytoken replay from a single machine blocked every default curl client.
 *
 * So an automatic block may be fingerprint-wide ONLY when the fingerprint is
 * DISTINCTIVE. Everything else is GENERIC and the automatic block is withheld
 * (report-only + an alert recommending an admin review). An admin may still
 * block a generic fingerprint tool-wide, explicitly, from the board.
 *
 * Two layers, both deterministic:
 *   1. STATIC (pure, from the fingerprint string alone, used at read AND write):
 *        - no kind (a legacy header-only fp)                        -> generic
 *        - a named scanner tool (sqlmap, nikto, nuclei, ...)        -> distinctive
 *          (every user of an attack tool is hostile; the attack-tool rule
 *          blocks these per request anyway)
 *        - "unknown" (automation with no recognized marker)         -> needs data
 *        - any other kind: a library, headless browser, crawler,
 *          browser, a generic client type, an unrecognized name    -> generic
 *   2. DATA (write time only, for "unknown"): how widely the HEADER SHAPE is
 *      shared in the recent event stream. A shape emitted by two or more
 *      different kinds is a default shape (1c168f78 is sent by curl,
 *      python-requests, urllib-style clients and unbranded scripts alike), and a
 *      shape seen from GENERIC_MIN_COUNTRIES or more countries is not one actor.
 *      If the data cannot be read, the fingerprint is treated as generic
 *      (precision first: a missed auto-block is still caught per request by the
 *      decoy / payload / attack-tool rules; a wrong one locks out real users).
 *
 * Why not scope the block to the attacker's network instead: the honeytoken
 * auto-block is written from the ingest path, where no client IP arrives by
 * design (vendored sites forward events without it), ASN is not populated in
 * production, and the vendored edges match a flat fingerprint list. A network
 * key would need a new stored quasi-identifier and a redeploy of every vendored
 * edge before it could enforce anything. See the PR for the full trade-off.
 *
 * PURE: no I/O, no model client. The data loader lives in blocked-fingerprints.ts.
 */
import { DEFAULT_TOOL_SIGNATURES, type ToolSignature } from "@/lib/forcefield-web/fingerprint";

/** A header shape seen with this many distinct kinds is a default client shape. */
export const GENERIC_MIN_KINDS = 2;
/** A header shape seen from this many distinct countries is not a single actor. */
export const GENERIC_MIN_COUNTRIES = 3;

export type ScopeVerdict = "generic" | "distinctive";

export interface FingerprintScope {
  verdict: ScopeVerdict;
  /** Stable reason id, recorded on forcefield.autoblock_withheld_generic. */
  why:
    | "legacy_no_kind"
    | "named_attack_tool"
    | "common_client_kind"
    | "shared_header_shape"
    | "wide_country_spread"
    | "spread_unavailable"
    | "rare_header_shape";
  /** The fingerprint's kind (tool or client type), lowercased; "" when absent. */
  kind: string;
}

/** How widely one header shape is shared in the recent event stream. */
export interface HeaderShapeSpread {
  /** Distinct kinds (tool / client type) seen with this header shape. */
  kinds: number;
  /** Distinct countries seen with this header shape. */
  countries: number;
}

/** Split an operator fingerprint into its header shape and kind. */
export function splitFingerprint(fp: string): { shape: string; kind: string } {
  const s = (fp ?? "").trim().toLowerCase();
  const i = s.indexOf(":");
  if (i < 0) return { shape: s, kind: "" };
  return { shape: s.slice(0, i), kind: s.slice(i + 1) };
}

/** The lowercased kinds that name an attack / recon tool. */
export function attackToolKinds(signatures: readonly ToolSignature[] = DEFAULT_TOOL_SIGNATURES): Set<string> {
  const out = new Set<string>();
  for (const [display, , type] of signatures) if (type === "scanner") out.add(display.toLowerCase());
  return out;
}

const DEFAULT_ATTACK_KINDS = attackToolKinds();

/**
 * The static verdict from the fingerprint string alone. Returns null for the one
 * kind that needs data ("unknown"). Pure + deterministic.
 */
export function staticFingerprintScope(fp: string, attackKinds: ReadonlySet<string> = DEFAULT_ATTACK_KINDS): FingerprintScope | null {
  const { kind } = splitFingerprint(fp);
  if (!kind) return { verdict: "generic", why: "legacy_no_kind", kind };
  if (attackKinds.has(kind)) return { verdict: "distinctive", why: "named_attack_tool", kind };
  if (kind === "unknown") return null;
  return { verdict: "generic", why: "common_client_kind", kind };
}

/** True when an AUTOMATIC row for this fingerprint must never be distributed,
 *  whatever the data says. Used by the ruleset read path, which runs per request
 *  and so reads no event data. */
export function isStaticallyGeneric(fp: string, attackKinds?: ReadonlySet<string>): boolean {
  return staticFingerprintScope(fp, attackKinds)?.verdict === "generic";
}

/**
 * The full verdict for an automatic block at write time: the static rule, then
 * (for "unknown") the header-shape spread. A null spread means the data could
 * not be read, which is generic (fail toward not blocking real users).
 */
export function classifyAutoBlockScope(
  fp: string,
  spread: HeaderShapeSpread | null,
  attackKinds?: ReadonlySet<string>,
): FingerprintScope {
  const fixed = staticFingerprintScope(fp, attackKinds);
  if (fixed) return fixed;
  const kind = "unknown";
  if (!spread) return { verdict: "generic", why: "spread_unavailable", kind };
  if (spread.kinds >= GENERIC_MIN_KINDS) return { verdict: "generic", why: "shared_header_shape", kind };
  if (spread.countries >= GENERIC_MIN_COUNTRIES) return { verdict: "generic", why: "wide_country_spread", kind };
  return { verdict: "distinctive", why: "rare_header_shape", kind };
}
