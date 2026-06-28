/**
 * gate-rate-limit: per-API-key throttle for the bring-your-own-agent gate.
 *
 * POST /api/gate/authorize lets an EXTERNAL agent (any model/framework) ask the
 * OGIAM gate to authorize an action. Every authorized request also writes a row
 * to the tamper-evident decision ledger, so an unthrottled key could both flood
 * our gate and bloat the ledger. checkRateLimit() caps each key to a fixed number
 * of requests per window.
 *
 * WHY A DB FIXED-WINDOW COUNTER (chosen for v1):
 *
 *   In-memory (Map<keyId, count>) - REJECTED. Vercel runs the route across many
 *     serverless instances; an in-process counter is per-instance, so the real
 *     cap becomes (limit x instance_count) and resets on every cold start. It
 *     gives the illusion of a limit while enforcing nothing. Unacceptable for a
 *     security control.
 *
 *   DB fixed-window counter - CHOSEN. One row per (key_id, window_start); each
 *     request is a single atomic upsert (INSERT ... ON CONFLICT DO UPDATE SET
 *     count = count + 1 RETURNING count). The post-increment count is compared to
 *     the limit. Shared across every instance, deterministic, no new runtime
 *     dependency, and trivially testable with an injected clock + db. The window
 *     is a fixed slice of wall-clock time (request time floored to the window
 *     size), not sliding - simpler and cheaper, with a bounded worst case of up
 *     to 2x the limit across a window boundary, which is acceptable for v1.
 *
 *   External service (Upstash / Redis) - the SCALE PATH, not v1. When per-request
 *     Postgres writes become the bottleneck, move the counter to Redis INCR +
 *     EXPIRE behind this SAME checkRateLimit() signature. Only the store changes;
 *     no call site changes. We deliberately avoid adding a runtime dependency
 *     before the traffic justifies it.
 *
 * FAIL-CLOSED: if the DB write throws (and we are not in shadow mode), the
 * request is denied. A rate limiter that fails open is not a limiter. The one
 * exception is shadow mode (no DATABASE_URL), where there is no store to count
 * against; there we allow, mirroring the rest of the codebase's shadow-mode
 * behavior (the gate ledger itself no-ops without a DB).
 */

import { query } from "@/lib/db";

/** Default cap: 120 requests per 60-second window per key. Override via deps in
 *  tests or a future per-key config. */
export const DEFAULT_LIMIT = 120;
export const DEFAULT_WINDOW_MS = 60_000;

export interface RateLimitDeps {
  /** Per-window request cap. Defaults to DEFAULT_LIMIT. */
  limit?: number;
  /** Window size in milliseconds. Defaults to DEFAULT_WINDOW_MS. */
  windowMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Injectable atomic increment. Returns the post-increment count for the
   * (keyId, windowStart) row. Defaults to the Postgres upsert. Injected in tests
   * so no DB is touched.
   */
  increment?: (keyId: string, windowStartIso: string) => Promise<number>;
}

export interface RateLimitResult {
  ok: boolean;
  /** Requests remaining in the current window (never negative). */
  remaining: number;
}

/**
 * Floor a timestamp (ms) to the start of its fixed window.
 * Pure - exported for the unit tests.
 */
export function windowStartMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Default store increment: one atomic upsert against instinct_gate_rate_limits.
 * Returns the post-increment count. THROWS on DB error so the caller can
 * fail closed.
 */
async function dbIncrement(
  keyId: string,
  windowStartIso: string,
): Promise<number> {
  const res = await query<{ count: number }>(
    `INSERT INTO instinct_gate_rate_limits (key_id, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (key_id, window_start)
     DO UPDATE SET count = instinct_gate_rate_limits.count + 1
     RETURNING count`,
    [keyId, windowStartIso],
  );
  return Number(res.rows[0]?.count ?? 0);
}

/**
 * Check (and consume) one unit of the key's rate-limit budget for the current
 * fixed window. Returns { ok, remaining }.
 *
 * - Shadow mode (no DATABASE_URL and no injected increment): allow, full budget
 *   reported - there is no store to count against.
 * - DB error in enforce mode: FAIL CLOSED -> { ok: false, remaining: 0 }.
 */
export async function checkRateLimit(
  keyId: string,
  deps: RateLimitDeps = {},
): Promise<RateLimitResult> {
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? Date.now;

  // Shadow mode: no real DB and no injected store -> nothing to count against.
  if (!deps.increment && !process.env.DATABASE_URL) {
    return { ok: true, remaining: limit };
  }

  const increment = deps.increment ?? dbIncrement;
  const windowStartIso = new Date(windowStartMs(now(), windowMs)).toISOString();

  let count: number;
  try {
    count = await increment(keyId, windowStartIso);
  } catch {
    // Fail closed: a limiter that errors open is not a limiter.
    return { ok: false, remaining: 0 };
  }

  const remaining = Math.max(0, limit - count);
  return { ok: count <= limit, remaining };
}
