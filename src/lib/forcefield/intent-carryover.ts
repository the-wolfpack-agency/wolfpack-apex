/**
 * Forcefield intent CARRYOVER - the sending half.
 *
 * An actor proven hostile on one Forcefield site (a decoy taken, a live payload,
 * a honeypot field) should not arrive fresh on the next one. This builds the
 * list the central ruleset distributes as `intentCarryover`: the fingerprints
 * that carried proof recently, each with its own expiry. A connected site that
 * sees one of them starts that session at the tarpit threshold (intent.ts
 * carriesOver). Carryover only ever TARPITS; a hard block still needs proof on
 * the site itself.
 *
 * Never on a GENERIC fingerprint: a fingerprint is header shape + tool with no
 * network part, so default curl or a headless browser is shared by unrelated
 * users. The same autoblock-scope rule the automatic block uses decides
 * (static kind, then the header-shape spread for "unknown"); a generic or
 * unreadable one is withheld.
 *
 * Read-only, cached per instance, fail-safe: any DB error serves the last good
 * list or an empty one, never a wrong one. Non-PII: fingerprints are header-order
 * hashes, never an identity.
 */
import { NOT_CONTROL_PLANE_FP } from "@/lib/site-analytics-proven";
import { resolveAutoBlockScope, type AutoBlockScopeDeps } from "@/lib/forcefield/blocked-fingerprints";
import type { CarryoverEntry } from "@/lib/forcefield-web/intent";

/** How long a proven fingerprint carries over after its LAST proof. */
export const CARRYOVER_TTL_DAYS = 7;
/** Most entries served (newest proof first). Bounds the ruleset size. */
export const CARRYOVER_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 10 * 60_000;

const PROOF_TYPES = ["site.agent_trap_tripped", "site.agent_payload_attack", "site.agent_form_honeypot"];

export interface ProvenFingerprint {
  fp: string;
  /** ISO time of the most recent proof. */
  lastProof: string;
}

/** Pure: turn proven fingerprints into expiring entries, distinctive only. */
export async function planCarryover(
  proven: readonly ProvenFingerprint[],
  opts: { now?: Date; ttlDays?: number; max?: number; scope?: AutoBlockScopeDeps } = {},
): Promise<{ entries: CarryoverEntry[]; withheldGeneric: number }> {
  const now = (opts.now ?? new Date()).getTime();
  const ttlMs = (opts.ttlDays ?? CARRYOVER_TTL_DAYS) * 86_400_000;
  const max = opts.max ?? CARRYOVER_MAX_ENTRIES;
  const fresh = [...proven]
    .filter((p) => p.fp && now - Date.parse(p.lastProof) < ttlMs)
    .sort((a, b) => Date.parse(b.lastProof) - Date.parse(a.lastProof))
    .slice(0, max);
  const entries: CarryoverEntry[] = [];
  let withheldGeneric = 0;
  for (const p of fresh) {
    const scope = await resolveAutoBlockScope(p.fp, opts.scope ?? {}).catch(() => null);
    if (!scope || scope.verdict !== "distinctive") {
      withheldGeneric++;
      continue;
    }
    entries.push({ fp: p.fp, expiresAt: new Date(Date.parse(p.lastProof) + ttlMs).toISOString() });
  }
  return { entries, withheldGeneric };
}

let _cache: { at: number; entries: CarryoverEntry[] } | null = null;

/** Test-only. */
export function _resetCarryoverCache(): void {
  _cache = null;
}

/** The carryover list to distribute. Cached; [] on any error with no cache. */
export async function getIntentCarryover(nowMs = Date.now()): Promise<CarryoverEntry[]> {
  if (!process.env.DATABASE_URL) return [];
  if (_cache && nowMs - _cache.at < CACHE_TTL_MS) return _cache.entries.filter((e) => Date.parse(e.expiresAt) > nowMs);
  try {
    const { query } = await import("@/lib/db");
    const res = await query<{ fp: string; last_proof: string }>(
      `SELECT props->>'fp' AS fp, max(created_at)::text AS last_proof
         FROM site_analytics_events
        WHERE event_type = ANY($1::text[])
          AND created_at > now() - ($2 || ' days')::interval
          AND props->>'fp' IS NOT NULL AND props->>'fp' <> ''
          AND COALESCE(props->>'synthetic', '') <> 'true'${NOT_CONTROL_PLANE_FP}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT $3`,
      [PROOF_TYPES, String(CARRYOVER_TTL_DAYS), CARRYOVER_MAX_ENTRIES],
    );
    const { entries } = await planCarryover(res.rows.map((r) => ({ fp: r.fp, lastProof: new Date(r.last_proof).toISOString() })));
    _cache = { at: nowMs, entries };
    return entries;
  } catch {
    return _cache?.entries.filter((e) => Date.parse(e.expiresAt) > nowMs) ?? [];
  }
}
