/**
 * Proven attacks, per protected site: the events the edge engine PROVED hostile
 * (a live payload or a decoy trip), split blocked vs report-only. This is what an
 * operator opens the Forcefield board for; flagged / welcomed / page-view volume
 * is context and lives in the panels below it.
 *
 * Proven = event_type in (site.agent_payload_attack, site.agent_trap_tripped),
 * minus the known control-plane false positive (see CONTROL_PLANE_FP_ROW).
 *
 * Reads only, through safeQuery. A failed query does not read as zero: the
 * result carries available=false so the board renders an error state instead
 * of a reassuring empty table.
 */

import { safeQuery } from "@/lib/db";
import { FORCEFIELD_CONTROL_PLANE_PATHS } from "@/lib/forcefield-web/enforce";

/** The two event types that are proof on their own. */
export const PROVEN_EVENT_TYPES = ["site.agent_payload_attack", "site.agent_trap_tripped"] as const;
export type ProvenEventType = (typeof PROVEN_EVENT_TYPES)[number];
const PROVEN_IN = PROVEN_EVENT_TYPES.map((t) => `'${t}'`).join(",");

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const CONTROL_PLANE_IN = Array.from(FORCEFIELD_CONTROL_PLANE_PATHS).map(sqlString).join(",");

/**
 * The control-plane false positive: before the fix in enforce.ts, our own edge
 * calls to the Forcefield control plane (ingest / ruleset / observe) carried
 * x-middleware-subrequest and were recorded as nextjs_middleware_bypass attacks.
 * The rows are still in the window. They are not attacks and must not count as
 * one anywhere on the board. Path list is the engine's own exemption list, so
 * the board and the engine can never disagree about which paths are exempt.
 */
export const CONTROL_PLANE_FP_ROW =
  `(props->>'attack' = 'nextjs_middleware_bypass' AND coalesce(props->>'path', path) IN (${CONTROL_PLANE_IN}))`;
/** Append to a WHERE clause to drop the control-plane false positive. A row
 *  with no attack prop compares NULL, so the coalesce keeps it. */
export const NOT_CONTROL_PLANE_FP = ` AND NOT coalesce(${CONTROL_PLANE_FP_ROW}, false)`;

export type ProvenMode = "blocked" | "reportOnly";

export interface ProvenAttackClass {
  /** props.attack for payloads; "decoy_trip" for a tripped decoy. */
  attack: string;
  eventType: ProvenEventType;
  count: number;
  /** Distinct operator fingerprints. null = no event in this class recorded one
   *  (older engine copies), which is NOT the same as zero operators. */
  fingerprints: number | null;
  /** Events in this class that carried no fingerprint. */
  withoutFingerprint: number;
  lastSeen: string | null;
}

export interface ProvenModeSummary {
  events: number;
  fingerprints: number | null;
  withoutFingerprint: number;
  lastSeen: string | null;
  byClass: ProvenAttackClass[];
}

export interface ProvenSite {
  site: string;
  blocked: ProvenModeSummary;
  reportOnly: ProvenModeSummary;
  /** Control-plane false-positive rows excluded from this site's counts. */
  excludedFalsePositives: number;
  /** Newest event of ANY type this site reported in the window, so a site that
   *  stopped reporting reads as stale, not as quiet. */
  lastReportAt: string | null;
}

export interface ProvenAttacks {
  /** false when any underlying query failed: the board shows an error, never 0. */
  available: boolean;
  generatedAt: string;
  sites: ProvenSite[];
  excludedFalsePositives: number;
}

export function emptyProvenMode(): ProvenModeSummary {
  return { events: 0, fingerprints: null, withoutFingerprint: 0, lastSeen: null, byClass: [] };
}

const MODE_SQL = `CASE WHEN props->>'blocked' = 'true' THEN 'blocked' ELSE 'report_only' END`;
const SITE_SQL = `coalesce(props->>'site', 'ogiam.com')`;
const FP_PRESENT = `(props->>'fp' IS NOT NULL AND props->>'fp' <> '')`;

interface ClassRow { site: string; mode: string; event_type: string; attack: string; count: string; fingerprints: string; without_fp: string; last_seen: string | null }
interface ModeRow { site: string; mode: string; count: string; fingerprints: string; without_fp: string; last_seen: string | null }
interface CountRow { site: string; n: string }
interface LastRow { site: string; last_at: string | null }

/** Zero distinct fingerprints means none was recorded, not zero operators. */
const fpOrNull = (distinct: number): number | null => (distinct > 0 ? distinct : null);

/**
 * Per-site proven attacks for the window. `sinceClause` / `surfaceClause` /
 * `params` are the board's own (days as $1, optional surface as $2), and
 * `knownSites` is the board's surface list so a site with zero proven events
 * still gets a row (and its explicit empty state) instead of vanishing.
 */
export async function getProvenAttacks(
  sinceClause: string,
  surfaceClause: string,
  params: string[],
  knownSites: readonly string[],
): Promise<ProvenAttacks> {
  const where = `WHERE ${sinceClause}${surfaceClause}`;
  const [classes, modes, excluded, last] = await Promise.all([
    safeQuery<ClassRow>(
      `SELECT ${SITE_SQL} AS site, ${MODE_SQL} AS mode, event_type,
              CASE WHEN event_type = 'site.agent_trap_tripped' THEN 'decoy_trip'
                   WHEN props->>'attack' IS NULL OR props->>'attack' = '' THEN 'unclassified'
                   ELSE props->>'attack' END AS attack,
              count(*) AS count,
              count(DISTINCT props->>'fp') FILTER (WHERE ${FP_PRESENT}) AS fingerprints,
              count(*) FILTER (WHERE NOT ${FP_PRESENT}) AS without_fp,
              max(created_at)::text AS last_seen
         FROM site_analytics_events
        ${where} AND event_type IN (${PROVEN_IN})${NOT_CONTROL_PLANE_FP}
        GROUP BY 1, 2, 3, 4 ORDER BY count(*) DESC LIMIT 500`,
      params,
    ),
    safeQuery<ModeRow>(
      `SELECT ${SITE_SQL} AS site, ${MODE_SQL} AS mode,
              count(*) AS count,
              count(DISTINCT props->>'fp') FILTER (WHERE ${FP_PRESENT}) AS fingerprints,
              count(*) FILTER (WHERE NOT ${FP_PRESENT}) AS without_fp,
              max(created_at)::text AS last_seen
         FROM site_analytics_events
        ${where} AND event_type IN (${PROVEN_IN})${NOT_CONTROL_PLANE_FP}
        GROUP BY 1, 2`,
      params,
    ),
    safeQuery<CountRow>(
      `SELECT ${SITE_SQL} AS site, count(*) AS n
         FROM site_analytics_events
        ${where} AND ${CONTROL_PLANE_FP_ROW}
        GROUP BY 1`,
      params,
    ),
    safeQuery<LastRow>(
      `SELECT ${SITE_SQL} AS site, max(created_at)::text AS last_at
         FROM site_analytics_events
        ${where}
        GROUP BY 1`,
      params,
    ),
  ]);

  const available = ![classes, modes, excluded, last].some((r) => r?.fromCache === true);
  const bySite = new Map<string, ProvenSite>();
  const siteOf = (name: string): ProvenSite => {
    let s = bySite.get(name);
    if (!s) {
      s = { site: name, blocked: emptyProvenMode(), reportOnly: emptyProvenMode(), excludedFalsePositives: 0, lastReportAt: null };
      bySite.set(name, s);
    }
    return s;
  };
  const modeKey = (m: string): ProvenMode => (m === "blocked" ? "blocked" : "reportOnly");

  // Every known site gets a row, so "no blocked attacks" is said, not implied.
  const filteredSurface = params.length > 1 ? params[1] : null;
  for (const s of knownSites) if (!filteredSurface || s === filteredSurface) siteOf(s);
  if (filteredSurface) siteOf(filteredSurface);

  for (const r of modes?.rows ?? []) {
    const events = Number(r.count), without = Number(r.without_fp), distinct = Number(r.fingerprints);
    siteOf(r.site)[modeKey(r.mode)] = { events, fingerprints: fpOrNull(distinct), withoutFingerprint: without, lastSeen: r.last_seen ?? null, byClass: [] };
  }
  for (const r of classes?.rows ?? []) {
    const events = Number(r.count), without = Number(r.without_fp), distinct = Number(r.fingerprints);
    const eventType: ProvenEventType = r.event_type === "site.agent_trap_tripped" ? "site.agent_trap_tripped" : "site.agent_payload_attack";
    siteOf(r.site)[modeKey(r.mode)].byClass.push({
      attack: r.attack, eventType, count: events, fingerprints: fpOrNull(distinct), withoutFingerprint: without, lastSeen: r.last_seen ?? null,
    });
  }
  let excludedTotal = 0;
  for (const r of excluded?.rows ?? []) {
    const n = Number(r.n);
    siteOf(r.site).excludedFalsePositives = n;
    excludedTotal += n;
  }
  for (const r of last?.rows ?? []) siteOf(r.site).lastReportAt = r.last_at ?? null;

  const sites = Array.from(bySite.values()).sort(
    (a, b) => b.blocked.events - a.blocked.events || b.reportOnly.events - a.reportOnly.events || a.site.localeCompare(b.site),
  );
  for (const s of sites) {
    s.blocked.byClass.sort((a, b) => b.count - a.count);
    s.reportOnly.byClass.sort((a, b) => b.count - a.count);
  }
  return { available, generatedAt: new Date().toISOString(), sites, excludedFalsePositives: excludedTotal };
}
