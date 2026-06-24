/**
 * Site analytics: usage telemetry from the OGIAM marketing site, stored in our
 * OWN platform (site_analytics_events, migration 178) and aggregated for the
 * admin Site Analytics page. No third-party analytics product; the data feeds
 * the same Postgres source of truth as everything else.
 *
 * Privacy: anonymous. Only the event type, page path, coarse country (2-letter),
 * and referrer host are kept. No IP, no user id, no cookies.
 */

import { query, safeQuery } from "@/lib/db";

/** Closed event vocabulary, mirrored from the marketing site's analytics. A
 *  value outside this set is rejected at the ingest boundary. */
export const SITE_EVENT_TYPES = [
  "site.page_viewed",
  "site.section_viewed",
  "site.cta_clicked",
  "site.contact_submitted",
  "site.contact_failed",
] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];

export function isSiteEventType(v: unknown): v is SiteEventType {
  return typeof v === "string" && (SITE_EVENT_TYPES as readonly string[]).includes(v);
}

export interface RecordSiteEventInput {
  eventType: SiteEventType;
  /** Page path, e.g. "/ogiam-iam". Trimmed + length-capped by the caller. */
  path?: string | null;
  /** 2-letter country code from the edge geo header, or null. */
  country?: string | null;
  /** Referrer HOST only (no full URL / query), or null. */
  referrerHost?: string | null;
  /** Coarse, non-identifying props (which CTA, which section). No PII. */
  props?: Record<string, string | number | boolean>;
}

/** Persist one site event. Best effort: no DATABASE_URL -> no-op; never throws,
 *  so analytics can never break the ingest request. */
export async function recordSiteEvent(input: RecordSiteEventInput): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO site_analytics_events (event_type, path, country, referrer_host, props)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.eventType,
        input.path ?? null,
        input.country ?? null,
        input.referrerHost ?? null,
        JSON.stringify(input.props ?? {}),
      ],
    );
  } catch (err) {
    console.warn("[site-analytics] record failed:", (err as Error).message);
  }
}

export interface SiteAnalyticsSummary {
  rangeDays: number;
  totalPageViews: number;
  totalEvents: number;
  /** 0..23 buckets of page views by hour of day (UTC), for the heatmap. */
  byHour: Array<{ hour: number; count: number }>;
  byPage: Array<{ path: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
}

/** Clamp the requested window to a sane integer day count. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(days)));
}

/**
 * Aggregate the last `rangeDays` of site telemetry into the shapes the admin
 * page renders. Pure SQL aggregation; reads only. Degrades to empty arrays when
 * the DB is unavailable (safeQuery), never throws.
 */
export async function getSiteAnalyticsSummary(rangeDays = 30): Promise<SiteAnalyticsSummary> {
  const days = clampDays(rangeDays);
  const sinceClause = `created_at > now() - ($1 || ' days')::interval`;

  const [hour, page, country, type, totals] = await Promise.all([
    safeQuery<{ hour: number; count: string }>(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause} AND event_type = 'site.page_viewed'
        GROUP BY 1 ORDER BY 1`,
      [String(days)],
    ),
    safeQuery<{ path: string; count: string }>(
      `SELECT coalesce(path, '(unknown)') AS path, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause} AND event_type = 'site.page_viewed'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      [String(days)],
    ),
    safeQuery<{ country: string; count: string }>(
      `SELECT coalesce(country, '(unknown)') AS country, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause} AND event_type = 'site.page_viewed'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      [String(days)],
    ),
    safeQuery<{ event_type: string; count: string }>(
      `SELECT event_type, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}
        GROUP BY 1 ORDER BY count(*) DESC`,
      [String(days)],
    ),
    safeQuery<{ page_views: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'site.page_viewed') AS page_views,
         count(*) AS total
         FROM site_analytics_events
        WHERE ${sinceClause}`,
      [String(days)],
    ),
  ]);

  const t = totals.rows[0];
  return {
    rangeDays: days,
    totalPageViews: t ? Number(t.page_views) : 0,
    totalEvents: t ? Number(t.total) : 0,
    byHour: hour.rows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) })),
    byPage: page.rows.map((r) => ({ path: r.path, count: Number(r.count) })),
    byCountry: country.rows.map((r) => ({ country: r.country, count: Number(r.count) })),
    byType: type.rows.map((r) => ({ type: r.event_type, count: Number(r.count) })),
  };
}
