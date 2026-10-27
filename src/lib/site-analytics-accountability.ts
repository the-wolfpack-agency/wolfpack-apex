/**
 * Accountable actions on the board: per protected site, how many state-changing
 * requests came from each accountability class, and how many "hold for review"
 * WOULD have held. Watch mode only: nothing was held; these are the numbers that
 * decide whether it ever should be (docs/forcefield/accountable-actions.md).
 *
 * Reads site_analytics_events rows that carry props.accountability (stamped by
 * src/lib/forcefield-web/accountability.ts at the edge and refined at the
 * ingest / observe boundary). Our own verified synthetic probes are excluded.
 * Counts only: no paths, principals, fingerprints or countries leave here.
 * A failed read (safeQuery fromCache) sets available=false so the board shows
 * an error, never a zero. Never throws.
 */
import { safeQuery } from "@/lib/db";
import { ACCOUNTABILITY_CLASSES, type AccountabilityClass } from "@/lib/forcefield-web/accountability";

export interface AccountableSiteRow {
  site: string;
  total: number;
  browserSession: number;
  signedWithin: number;
  signedOutside: number;
  unaccountable: number;
  wouldHold: number;
}

export interface AccountableActionsSummary {
  /** False when the read failed: the board shows an error, never a zero. */
  available: boolean;
  rangeDays: number;
  surface: string;
  totals: Omit<AccountableSiteRow, "site">;
  sites: AccountableSiteRow[];
  /** Would-hold actions by reason (what would trip the hold), for tuning. */
  heldReasons: Array<{ reason: string; count: number }>;
  /** Actions by kind (login, checkout, form, ...), with their would-hold share. */
  kinds: Array<{ kind: string; count: number; wouldHold: number }>;
}

/** One aggregate row: (site, class, mandate, would_hold) -> count. */
export interface AccountabilityAggRow {
  site: string;
  cls: string;
  mandate: string | null;
  would_hold: string | null;
  count: string | number;
}

const empty = (): Omit<AccountableSiteRow, "site"> => ({ total: 0, browserSession: 0, signedWithin: 0, signedOutside: 0, unaccountable: 0, wouldHold: 0 });

/** Fold aggregate rows into per-site counts. Pure; unknown classes ignored. */
export function summarizeAccountability(rows: readonly AccountabilityAggRow[]): { totals: Omit<AccountableSiteRow, "site">; sites: AccountableSiteRow[] } {
  const bySite = new Map<string, AccountableSiteRow>();
  const totals = empty();
  for (const r of rows) {
    if (!(ACCOUNTABILITY_CLASSES as readonly string[]).includes(r.cls)) continue;
    const n = Number(r.count) || 0;
    if (n <= 0) continue;
    const row = bySite.get(r.site) ?? { site: r.site, ...empty() };
    const cls = r.cls as AccountabilityClass;
    for (const t of [row, totals]) {
      t.total += n;
      if (cls === "browser_session") t.browserSession += n;
      else if (cls === "unaccountable") t.unaccountable += n;
      else if (r.mandate === "within") t.signedWithin += n;
      else t.signedOutside += n;
      if (r.would_hold === "true") t.wouldHold += n;
    }
    bySite.set(r.site, row);
  }
  const sites = Array.from(bySite.values()).sort((a, b) => b.total - a.total || a.site.localeCompare(b.site));
  return { totals, sites };
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(days)));
}

export async function getAccountableActions(rangeDays = 30, surface = "all"): Promise<AccountableActionsSummary> {
  const days = clampDays(rangeDays);
  const filtered = surface !== "all" && surface.length > 0;
  const params = filtered ? [String(days), surface] : [String(days)];
  const where =
    `WHERE created_at > now() - ($1 || ' days')::interval AND props ? 'accountability'` +
    ` AND coalesce(props->>'synthetic', '') <> 'true'` +
    (filtered ? ` AND coalesce(props->>'site', 'ogiam.com') = $2` : "");
  const [agg, reasons, kinds] = await Promise.all([
    safeQuery<AccountabilityAggRow>(
      `SELECT coalesce(props->>'site', 'ogiam.com') AS site, props->>'accountability' AS cls,
              props->>'mandate' AS mandate, props->>'would_hold' AS would_hold, count(*) AS count
         FROM site_analytics_events ${where}
        GROUP BY 1, 2, 3, 4`,
      params,
    ),
    safeQuery<{ reason: string; count: string }>(
      `SELECT coalesce(props->>'acct_reason', 'unspecified') AS reason, count(*) AS count
         FROM site_analytics_events ${where} AND props->>'would_hold' = 'true'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`,
      params,
    ),
    safeQuery<{ kind: string; count: string; would_hold: string }>(
      `SELECT coalesce(props->>'action_kind', 'form') AS kind, count(*) AS count,
              count(*) FILTER (WHERE props->>'would_hold' = 'true') AS would_hold
         FROM site_analytics_events ${where}
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`,
      params,
    ),
  ]);
  const { totals, sites } = summarizeAccountability(agg?.rows ?? []);
  return {
    available: ![agg, reasons, kinds].some((r) => !r || r.fromCache === true),
    rangeDays: days,
    surface: filtered ? surface : "all",
    totals,
    sites,
    heldReasons: (reasons?.rows ?? []).map((r) => ({ reason: r.reason, count: Number(r.count) || 0 })),
    kinds: (kinds?.rows ?? []).map((r) => ({ kind: r.kind, count: Number(r.count) || 0, wouldHold: Number(r.would_hold) || 0 })),
  };
}
