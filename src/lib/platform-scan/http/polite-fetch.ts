/**
 * Politeness layer for platform-scan HTTP probes.
 *
 * WHY THIS EXISTS
 * ---------------
 * A scan crawls a client's PRODUCTION system. The very first client-facing
 * failure we must never cause is knocking that system over on day one. The old
 * engine fired EVERY route in the manifest through one unbounded `Promise.all`,
 * with no per-host concurrency cap, no inter-request pacing, and no honoring of a
 * 429/503 `Retry-After` (a 429 was flagged as a finding, then immediately
 * re-hammered on the next route). A 50-route manifest meant 50 simultaneous
 * connections to one origin. That is impolite and dangerous.
 *
 * This module is the SHARED, TESTED politeness layer every scan fetch flows
 * through. It provides:
 *   1. Bounded per-host concurrency (a semaphore keyed by host).
 *   2. A minimum gap between requests to the SAME host (token-bucket style pace).
 *   3. Honoring `Retry-After` on 429/503 + exponential backoff with jitter, with
 *      a capped retry count and an absolute backoff ceiling (no infinite loop).
 *   4. An overall ceiling: concurrency is bounded, retries are bounded, so the
 *      total request rate to any one host is provably capped.
 *
 * It NEVER throws on a normal non-2xx (a 404 / 401 / 500 is a finding, not an
 * error). It returns the final `Response` so the engine classifies findings
 * EXACTLY as before. The only behavioral change is timing + retry-on-throttle;
 * the observation handed to `classify()` is unchanged.
 *
 * TOOL COMPARISON (per the repo rule: "no new runtime dependencies without
 * justification" - .ai conventions + global engineering directive)
 * ----------------------------------------------------------------------------
 * Need: (1) per-host concurrency cap, (2) min inter-request gap per host,
 * (3) Retry-After + capped exponential backoff on 429/503, (4) overall ceiling.
 *
 *   - p-limit: a single global concurrency limiter. Tiny, but limits GLOBALLY,
 *     not PER HOST, and offers NO pacing and NO retry/backoff. We would still
 *     hand-roll pacing + the Retry-After logic, so the dep buys almost nothing.
 *   - p-queue: per-queue concurrency + interval caps (intervalCap). Closer, but
 *     one queue is one host; we would still manage a queue-per-host map, and it
 *     has NO Retry-After/backoff. Still a hand-rolled retry layer on top.
 *   - Bottleneck: the richest (reservoir, minTime, per-key groups, retries). It
 *     covers concurrency + minTime + per-key (Group) + retries. But it is a
 *     ~30KB dep with timers/clustering features we do not need, its clock is not
 *     injectable for deterministic tests (we want a fake clock + fake sleep so
 *     the suite has NO real timers), and Retry-After parsing (HTTP-date form)
 *     is still ours to write.
 *
 * DECISION: hand-roll a small async semaphore + token-bucket pace + backoff.
 * Rationale: (a) zero new runtime deps, matching the repo rule; (b) the logic is
 * ~150 lines and fully covered; (c) clock + sleep + fetch are all INJECTABLE, so
 * tests are fast and deterministic (no real timers, no real network) - Bottleneck
 * could not give us that. If the politeness needs grow (cross-process reservoir,
 * distributed rate limits) Bottleneck becomes justified; today it is not.
 */

/** Default max simultaneous in-flight requests to a SINGLE host. Small on
 *  purpose: a scan is a guest on a client's prod box, not a load test. */
export const DEFAULT_PER_HOST_CONCURRENCY = 4;

/** Default minimum gap between the START of two requests to the same host. */
export const DEFAULT_MIN_GAP_MS = 150;

/** Default max retries on a throttle/unavailable response (429/503). */
export const DEFAULT_MAX_RETRIES = 3;

/** Base for exponential backoff when no Retry-After is given (ms). */
export const DEFAULT_BASE_BACKOFF_MS = 500;

/** Absolute ceiling for any single backoff wait (ms). Caps a hostile or
 *  fat-fingered Retry-After (e.g. "Retry-After: 86400") so a scan can never be
 *  parked for hours; we give up politely instead. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Statuses that mean "back off and retry," not "this is a finding to report."
 *  429 = rate limited, 503 = service unavailable / overloaded. */
const RETRYABLE_STATUSES = new Set([429, 503]);

export interface PoliteFetchOptions {
  perHostConcurrency?: number;
  minGapMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock; defaults to Date.now. Lets tests advance time deterministically. */
  now?: () => number;
  /** Injected sleep; defaults to a real setTimeout. Tests pass a no-op / fake-clock
   *  advancer so there are NO real timers. Resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injected randomness for the backoff jitter; defaults to Math.random.
   *
   * `now` and `sleep` were already injectable so a test could run with no real
   * timers, and then the jitter was left on Math.random — which made the class
   * testable except for the one input that decides how long it waits. Full
   * jitter multiplies by rand(), so a draw near zero rounds the backoff to 0,
   * and a test asserting "some backoff happened" fails roughly once in 500
   * runs. That is a CI flake nobody can reproduce locally, which is the worst
   * kind.
   */
  rand?: () => number;
  /** Called when a request backs off, so the caller can fire
   *  `platform.scan_throttled`. Best-effort; never awaited, never throws. */
  onThrottle?: (info: ThrottleInfo) => void;
}

export interface ThrottleInfo {
  host: string;
  /** How long we are about to wait before the retry. */
  retryAfterMs: number;
  /** "429" | "503" - the status that triggered the backoff. */
  reason: string;
  /** Which retry attempt this is (1-based). */
  attempt: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Extract a host key from a URL; falls back to the raw string so an unparseable
 *  URL still gets its own (consistent) bucket rather than crashing. */
export function hostOf(url: string | URL): string {
  try {
    return new URL(typeof url === "string" ? url : url.toString()).host;
  } catch {
    return String(url);
  }
}

/**
 * Parse a Retry-After header into milliseconds.
 *
 * Two legal forms (RFC 9110): delta-seconds (an integer) or an HTTP-date.
 * Returns null when absent/unparseable so the caller falls back to exponential
 * backoff. `now` is injected so the HTTP-date branch is deterministic in tests.
 * Negative / past values clamp to 0.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: () => number,
): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // delta-seconds form: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date form.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const delta = when - now();
  return delta > 0 ? delta : 0;
}

/** Compute the backoff for an attempt: prefer Retry-After, else exponential with
 *  full jitter, always clamped to [0, maxBackoffMs]. `attempt` is 1-based. */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  opts: { baseBackoffMs: number; maxBackoffMs: number; rand?: () => number },
): number {
  const rand = opts.rand ?? Math.random;
  let ms: number;
  if (retryAfterMs != null) {
    ms = retryAfterMs;
  } else {
    // Exponential: base * 2^(attempt-1), then FULL jitter so a fleet of probes
    // does not retry in lockstep (thundering herd).
    const exp = opts.baseBackoffMs * 2 ** (attempt - 1);
    ms = exp * rand();
  }
  if (ms < 0) ms = 0;
  if (ms > opts.maxBackoffMs) ms = opts.maxBackoffMs;
  return Math.round(ms);
}

/**
 * A tiny async semaphore: acquire() resolves when a slot is free; release()
 * hands the slot to the next waiter (FIFO). No timers, no deps.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // When woken, the releaser has already accounted for our permit.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter (do NOT bump `available`).
      next();
    } else {
      this.available += 1;
    }
  }
}

/** Per-host state: the concurrency gate + the timestamp of the last request
 *  start, used to enforce the minimum inter-request gap. */
interface HostState {
  sem: Semaphore;
  lastStartMs: number;
}

/**
 * A PoliteFetcher owns the per-host limiters + pacing for ONE scan run. Create
 * one per scan (so concurrency is scoped to that run) and call `.fetch()` for
 * every probe. All knobs are configurable; all I/O seams are injectable.
 */
export class PoliteFetcher {
  private readonly perHostConcurrency: number;
  private readonly minGapMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  private readonly onThrottle?: (info: ThrottleInfo) => void;
  private readonly hosts = new Map<string, HostState>();

  constructor(opts: PoliteFetchOptions = {}) {
    this.perHostConcurrency = Math.max(1, opts.perHostConcurrency ?? DEFAULT_PER_HOST_CONCURRENCY);
    this.minGapMs = Math.max(0, opts.minGapMs ?? DEFAULT_MIN_GAP_MS);
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.baseBackoffMs = Math.max(0, opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS);
    this.maxBackoffMs = Math.max(0, opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.rand = opts.rand ?? Math.random;
    this.onThrottle = opts.onThrottle;
  }

  private hostState(host: string): HostState {
    let st = this.hosts.get(host);
    if (!st) {
      st = { sem: new Semaphore(this.perHostConcurrency), lastStartMs: -Infinity };
      this.hosts.set(host, st);
    }
    return st;
  }

  /** Wait until at least minGapMs has elapsed since this host's last request
   *  start, then stamp the new start. Must be called while holding the host's
   *  semaphore so the stamp is serialized per acquisition. */
  private async pace(st: HostState): Promise<void> {
    if (this.minGapMs > 0) {
      const elapsed = this.now() - st.lastStartMs;
      const wait = this.minGapMs - elapsed;
      if (wait > 0) await this.sleep(wait);
    }
    st.lastStartMs = this.now();
  }

  /**
   * Politely fetch a URL. Bounded by the per-host concurrency cap + min gap, and
   * retries (capped) on 429/503 honoring Retry-After. Returns the final Response;
   * NEVER throws on a non-2xx. A transport throw (network error) propagates so
   * the engine records it as a networkError observation exactly as before.
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const host = hostOf(url);
    const st = this.hostState(host);

    await st.sem.acquire();
    try {
      let attempt = 0;
      // The first call is not a "retry"; we allow up to maxRetries ADDITIONAL
      // attempts after a throttle. Total fetches <= maxRetries + 1. The loop is
      // bounded by the `attempt >= maxRetries` return below (no infinite loop).
      for (;;) {
        await this.pace(st);
        const res = await this.fetchImpl(url as RequestInfo, init);

        if (!RETRYABLE_STATUSES.has(res.status) || attempt >= this.maxRetries) {
          // Either a normal response (incl. a 429 we are out of retries for, so
          // the engine still flags it as a finding) or we have exhausted retries.
          return res;
        }

        attempt += 1;
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after"), this.now);
        const backoffMs = computeBackoffMs(attempt, retryAfterMs, {
          baseBackoffMs: this.baseBackoffMs,
          maxBackoffMs: this.maxBackoffMs,
          rand: this.rand,
        });

        // Fire-and-forget analytics; never let it break the scan.
        try {
          this.onThrottle?.({ host, retryAfterMs: backoffMs, reason: String(res.status), attempt });
        } catch {
          /* analytics must never break a scan */
        }

        await this.sleep(backoffMs);
      }
    } finally {
      st.sem.release();
    }
  }
}

/**
 * Convenience wrapper: politeFetch(url, init, opts?) builds a one-off fetcher.
 * Prefer constructing ONE PoliteFetcher per scan so concurrency is shared across
 * all routes of that run; this helper is for single isolated probes.
 */
export function politeFetch(
  url: string | URL,
  init?: RequestInit,
  opts?: PoliteFetchOptions,
): Promise<Response> {
  return new PoliteFetcher(opts).fetch(url, init);
}
