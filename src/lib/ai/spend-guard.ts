/**
 * What the router reads before it decides what a call may cost.
 *
 * WHY THIS EXISTS RATHER THAN monthSpendUsd
 *
 * monthSpendUsd (workspace-policy.ts) returns 0 on every failure. That was the
 * right instinct, fail open, implemented in the wrong place: the router could
 * not tell "this workspace spent nothing" from "the spend could not be read",
 * so its own degraded-open branch, the one that is supposed to leave a trace,
 * could never fire. A budget backstop that silently stops applying looks
 * exactly like one that is working, and the first anybody hears of it is the
 * invoice. This reader THROWS on a failed read; the router catches, fails open,
 * and says so.
 *
 * TWO KINDS OF BUCKET
 *
 *   a workspace id        spend recorded against that workspace
 *   __unattributed__      spend recorded with no workspace at all
 *
 * The second one is the gap that mattered. Until this file, a call with no
 * metadata.workspace_id skipped the governor entirely, and ai.completion never
 * carried workspace_id in the first place, so on 2026-10-24 every one of the
 * 20,471 completions ever recorded was unattributed. Every dollar this
 * deployment has spent on AI was spent outside any cap. An LLMjacking loop, or
 * our own CI fixer stuck in a retry, is exactly an unattributed caller.
 *
 * WHY instinct_events AND NOT v_ai_cost_daily
 *
 * The view coalesces a missing workspace to 'default', and 'default' is also a
 * REAL workspace id in the single-tenant deployment (see lib/auth/workspace.ts).
 * Reading the view would charge every unattributed call to that workspace and
 * make the two buckets impossible to cap separately. The view also aggregates
 * the whole event history before the month filter applies; reading the event
 * table directly uses the (event_type, timestamp) index and touches one month.
 *
 * Pure apart from the injected query. No model is consulted: this is a sum.
 */

/** The bucket a call with no workspace is governed and alerted under. Double
 *  underscores so it cannot collide with an id anybody would choose. */
export const UNATTRIBUTED_BUCKET = "__unattributed__";

/** How long a spend read is reused. A runaway loop issues calls far faster
 *  than this, and without a cache every one of them would also be a database
 *  query, so the loop would cost twice. Thirty seconds of staleness against a
 *  governor whose stop line is twice the cap is not a gap anybody can exploit. */
export const SPEND_CACHE_TTL_MS = 30_000;

/** At most one degraded / unattributed trace per key per window, in-process.
 *  Enough to be found, not so much that one broken caller floods analytics. */
export const TRACE_WINDOW_MS = 15 * 60_000;

export type SpendQueryFn = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<{ month_spend_usd: number | string | null }> }>;

/** True when a workspace id carries no attribution. "default" is NOT one of
 *  these: it is a real workspace in a single-tenant deployment. */
export function isUnattributed(workspaceId: string | null | undefined): boolean {
  return !workspaceId || workspaceId.trim() === "" || workspaceId === UNATTRIBUTED_BUCKET;
}

/** The bucket a request is governed under. */
export function spendBucketFor(workspaceId: string | null | undefined): string {
  return isUnattributed(workspaceId) ? UNATTRIBUTED_BUCKET : (workspaceId as string).trim();
}

const COST = `COALESCE(SUM(NULLIF(metadata->>'cost_usd', '')::numeric), 0)`;

/**
 * This calendar month's spend for one bucket, in USD.
 *
 * THROWS when the query does. That is the point of this function; see the
 * header. Calendar month, matching monthSpendUsd, so the cap resets on the 1st
 * the way a finance team reads "monthly".
 */
export async function readMonthSpendUsd(bucket: string, queryFn: SpendQueryFn): Promise<number> {
  const unattributed = bucket === UNATTRIBUTED_BUCKET;
  const sql = unattributed
    ? `SELECT ${COST} AS month_spend_usd
         FROM instinct_events
        WHERE event_type = 'ai.completion'
          AND timestamp >= date_trunc('month', now())
          AND COALESCE(btrim(metadata->>'workspace_id'), '') = ''`
    : `SELECT ${COST} AS month_spend_usd
         FROM instinct_events
        WHERE event_type = 'ai.completion'
          AND timestamp >= date_trunc('month', now())
          AND metadata->>'workspace_id' = $1`;
  const result = await queryFn(sql, unattributed ? [] : [bucket]);
  const raw = result.rows[0]?.month_spend_usd ?? 0;
  const spend = typeof raw === "string" ? Number(raw) : (raw ?? 0);
  if (!Number.isFinite(spend)) throw new Error(`non-numeric spend for ${bucket}: ${String(raw)}`);
  return spend > 0 ? spend : 0;
}

/**
 * A cached spend reader. Failures are NOT cached: the next call tries again,
 * so a database blip costs one degraded window, not thirty seconds of them.
 */
export function createSpendReader(opts: {
  /** Returns null when there is no database (shadow / preview / unit tests):
   *  that is "nothing recorded", not a failed read, so it reads as 0. */
  resolveQuery: () => Promise<SpendQueryFn | null>;
  ttlMs?: number;
  now?: () => number;
}): { read: (bucket: string) => Promise<number>; reset: () => void } {
  const ttl = opts.ttlMs ?? SPEND_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; usd: number }>();
  return {
    read: async (bucket) => {
      const hit = cache.get(bucket);
      const t = now();
      if (hit && t - hit.at < ttl) return hit.usd;
      const q = await opts.resolveQuery();
      if (!q) return 0;
      const usd = await readMonthSpendUsd(bucket, q);
      cache.set(bucket, { at: t, usd });
      return usd;
    },
    reset: () => cache.clear(),
  };
}

/**
 * At most one emission per key per window, and a count of what was held back
 * so the one row that does land says how loud the caller really was.
 * Deterministic: the caller supplies the clock.
 */
export function createTraceThrottle(windowMs: number = TRACE_WINDOW_MS): {
  take: (key: string, nowMs: number) => { emit: boolean; suppressed: number };
  reset: () => void;
} {
  const state = new Map<string, { last: number; suppressed: number }>();
  return {
    take: (key, nowMs) => {
      const s = state.get(key);
      if (!s || nowMs - s.last >= windowMs) {
        const suppressed = s?.suppressed ?? 0;
        state.set(key, { last: nowMs, suppressed: 0 });
        return { emit: true, suppressed };
      }
      s.suppressed += 1;
      return { emit: false, suppressed: s.suppressed };
    },
    reset: () => state.clear(),
  };
}
