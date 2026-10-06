/**
 * PUBLIC Forcefield stats - the safe, aggregate headline numbers for the
 * marketing site (ogiam.com/forcefield).
 *
 * This is deliberately a MINIMAL, non-sensitive subset of what the admin board
 * sees: network-wide COUNTS only. It exposes no per-request detail, no operator
 * key or fingerprint, no path, no IP, no country, nothing that identifies a
 * visitor or a client - only how many agents were seen, welcomed, trapped, and
 * turned away across the OGIAM network, plus the attack-family breakdown. That is
 * the proof the marketing page shows, and it is safe to serve to anyone.
 *
 * Read-only and cheap (a handful of grouped counts over site_analytics_events),
 * meant to be served from a cached public route so the database is hit rarely.
 */
import { safeQuery } from "@/lib/db";

export interface PublicForcefieldStats {
  /** Window the counts cover, in days. */
  rangeDays: number;
  /** Every automated agent observed (all site.agent_* events). */
  agentsDetected: number;
  /** Known-good agents given the welcome lane. */
  welcomed: number;
  /** Scanners caught by an invisible honeypot (decoy trip). */
  trapped: number;
  /** Recon probes of sensitive paths (/wp-admin, /.env, ...). */
  probed: number;
  /** Live injection-payload attempts (path traversal, XSS, SQLi, ...). */
  payloads: number;
  /** Proven-hostile actions = probes + payloads + honeypot trips. */
  hostile: number;
  /** Distinct properties protected in-window. */
  sitesProtected: number;
  /** Injection attempts by family, for the attack breakdown. Highest first. */
  attacks: Array<{ attack: string; count: number }>;
}

/** Injectable query fn so the aggregate is unit-testable without a database. */
export type StatsQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

const liveQuery: StatsQuery = async <T,>(sql: string, params?: unknown[]) => {
  const res = await safeQuery<T>(sql, params ?? []);
  return res.rows;
};

/** The safe public rollup over the window. Never throws: on any error it returns
 *  a zeroed shape so a public page degrades to "0", never to a 500. */
export async function getPublicForcefieldStats(rangeDays = 30, q: StatsQuery = liveQuery): Promise<PublicForcefieldStats> {
  const empty: PublicForcefieldStats = {
    rangeDays, agentsDetected: 0, welcomed: 0, trapped: 0, probed: 0, payloads: 0, hostile: 0, sitesProtected: 0, attacks: [],
  };
  try {
    const since = `created_at > now() - ($1 || ' days')::interval`;
    const [counts] = await q<{
      agents: string; welcomed: string; trapped: string; probed: string; payloads: string; sites: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE event_type LIKE 'site.agent_%')              AS agents,
         count(*) FILTER (WHERE event_type = 'site.agent_welcomed')          AS welcomed,
         count(*) FILTER (WHERE event_type = 'site.agent_trap_tripped')      AS trapped,
         count(*) FILTER (WHERE event_type = 'site.agent_probed_sensitive')  AS probed,
         count(*) FILTER (WHERE event_type = 'site.agent_payload_attack')    AS payloads,
         count(DISTINCT coalesce(props->>'site', 'ogiam.com'))               AS sites
       FROM site_analytics_events
       WHERE ${since}`,
      [String(rangeDays)],
    );
    if (!counts) return empty;

    const attacks = await q<{ attack: string; n: string }>(
      `SELECT props->>'attack' AS attack, count(*) AS n
         FROM site_analytics_events
        WHERE ${since} AND event_type = 'site.agent_payload_attack' AND props->>'attack' IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
      [String(rangeDays)],
    );

    const n = (v: string | undefined): number => Math.max(0, Number(v ?? 0) || 0);
    const trapped = n(counts.trapped), probed = n(counts.probed), payloads = n(counts.payloads);
    return {
      rangeDays,
      agentsDetected: n(counts.agents),
      welcomed: n(counts.welcomed),
      trapped,
      probed,
      payloads,
      hostile: probed + payloads + trapped,
      sitesProtected: n(counts.sites),
      attacks: attacks.map((a) => ({ attack: a.attack, count: n(a.n) })).filter((a) => a.attack),
    };
  } catch {
    return empty;
  }
}
