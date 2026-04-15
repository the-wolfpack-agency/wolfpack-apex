/**
 * Audit Log → Learning Signals
 *
 * The audit log is both a compliance record AND a behavioral signal source.
 * This module turns raw audit rows into features the anomaly detector can
 * consume. The detector job itself is TODO (see bottom); here we just
 * surface the signals.
 *
 * Read-only — never mutates the audit log.
 */

import { safeQuery } from "@/lib/db";

export interface UserActivityScore {
  userId: string;
  windowDays: number;
  totalMutations: number;
  uniqueResourceTypes: number;
  uniqueResourceIds: number;
  /** Share of activity that happened in the user's "off hours" (22:00–06:00 local). */
  offHoursRatio: number;
  /** Count of distinct days with activity in the window. */
  activeDays: number;
  /** Top 5 most-touched resource types with counts, highest first. */
  topResources: Array<{ resource_type: string; count: number }>;
}

export interface UnusualAccessPattern {
  userId: string;
  windowDays: number;
  /** Resource types this user has NEVER accessed before the window. */
  firstTimeResourceTypes: string[];
  /** IP addresses this user has NEVER used before the window. */
  firstTimeIps: string[];
  /** User-agents this user has NEVER used before the window. */
  firstTimeUserAgents: string[];
  /** Simple 0..1 risk score — weighted sum of the above. */
  riskScore: number;
}

function windowFilterClause(param: string): string {
  return `ts >= NOW() - INTERVAL '1 day' * ${param}`;
}

/**
 * Aggregate activity metrics for a user over the last `windowDays` days.
 */
export async function getUserActivityScore(
  userId: string,
  windowDays = 30,
): Promise<UserActivityScore> {
  const empty: UserActivityScore = {
    userId,
    windowDays,
    totalMutations: 0,
    uniqueResourceTypes: 0,
    uniqueResourceIds: 0,
    offHoursRatio: 0,
    activeDays: 0,
    topResources: [],
  };

  if (!process.env.DATABASE_URL) return empty;

  const totals = await safeQuery<{
    total: string;
    uniq_types: string;
    uniq_ids: string;
    off_hours: string;
    active_days: string;
  }>(
    `SELECT
        COUNT(*)::text                                AS total,
        COUNT(DISTINCT resource_type)::text           AS uniq_types,
        COUNT(DISTINCT resource_id)::text             AS uniq_ids,
        COUNT(*) FILTER (
          WHERE EXTRACT(HOUR FROM ts) < 6 OR EXTRACT(HOUR FROM ts) >= 22
        )::text                                       AS off_hours,
        COUNT(DISTINCT DATE(ts))::text                AS active_days
     FROM instinct_audit_log
     WHERE actor_user_id = $1
       AND ${windowFilterClause("$2")}`,
    [userId, windowDays],
  );

  if (totals.rows.length === 0) return empty;
  const row = totals.rows[0];
  const total = Number(row.total) || 0;
  if (total === 0) return empty;

  const top = await safeQuery<{ resource_type: string; count: string }>(
    `SELECT resource_type, COUNT(*)::text AS count
     FROM instinct_audit_log
     WHERE actor_user_id = $1
       AND ${windowFilterClause("$2")}
     GROUP BY resource_type
     ORDER BY COUNT(*) DESC
     LIMIT 5`,
    [userId, windowDays],
  );

  return {
    userId,
    windowDays,
    totalMutations: total,
    uniqueResourceTypes: Number(row.uniq_types) || 0,
    uniqueResourceIds: Number(row.uniq_ids) || 0,
    offHoursRatio: total > 0 ? (Number(row.off_hours) || 0) / total : 0,
    activeDays: Number(row.active_days) || 0,
    topResources: top.rows.map((r) => ({
      resource_type: r.resource_type,
      count: Number(r.count) || 0,
    })),
  };
}

/**
 * Compare the user's recent window against their historical baseline and
 * surface things that are "new" — new resource types touched, new IPs,
 * new user-agents. Produces a simple risk score.
 */
export async function getUnusualAccessPatterns(
  userId: string,
  windowDays = 7,
): Promise<UnusualAccessPattern> {
  const empty: UnusualAccessPattern = {
    userId,
    windowDays,
    firstTimeResourceTypes: [],
    firstTimeIps: [],
    firstTimeUserAgents: [],
    riskScore: 0,
  };

  if (!process.env.DATABASE_URL) return empty;

  const recent = await safeQuery<{
    resource_type: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT DISTINCT resource_type, ip_address::text AS ip_address, user_agent
     FROM instinct_audit_log
     WHERE actor_user_id = $1
       AND ${windowFilterClause("$2")}`,
    [userId, windowDays],
  );

  if (recent.rows.length === 0) return empty;

  const recentTypes = new Set(recent.rows.map((r) => r.resource_type).filter(Boolean) as string[]);
  const recentIps = new Set(recent.rows.map((r) => r.ip_address).filter(Boolean) as string[]);
  const recentUAs = new Set(recent.rows.map((r) => r.user_agent).filter(Boolean) as string[]);

  const baseline = await safeQuery<{
    resource_type: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT DISTINCT resource_type, ip_address::text AS ip_address, user_agent
     FROM instinct_audit_log
     WHERE actor_user_id = $1
       AND ts < NOW() - INTERVAL '1 day' * $2`,
    [userId, windowDays],
  );

  const historicalTypes = new Set(
    baseline.rows.map((r) => r.resource_type).filter(Boolean) as string[],
  );
  const historicalIps = new Set(
    baseline.rows.map((r) => r.ip_address).filter(Boolean) as string[],
  );
  const historicalUAs = new Set(
    baseline.rows.map((r) => r.user_agent).filter(Boolean) as string[],
  );

  const firstTimeResourceTypes = [...recentTypes].filter((t) => !historicalTypes.has(t));
  const firstTimeIps = [...recentIps].filter((t) => !historicalIps.has(t));
  const firstTimeUserAgents = [...recentUAs].filter((t) => !historicalUAs.has(t));

  // Weighted risk score (capped at 1.0). New IPs weigh most heavily.
  const rawScore =
    firstTimeIps.length * 0.35 +
    firstTimeResourceTypes.length * 0.2 +
    firstTimeUserAgents.length * 0.15;

  return {
    userId,
    windowDays,
    firstTimeResourceTypes,
    firstTimeIps,
    firstTimeUserAgents,
    riskScore: Math.min(1, rawScore),
  };
}

// TODO(anomaly-detector): schedule a nightly job that runs
// `getUnusualAccessPatterns` for every active user, emits
// `system.unusual_access_pattern` when riskScore > 0.5, and feeds results
// into the graph / RAG layer so future policy decisions see the signal.
