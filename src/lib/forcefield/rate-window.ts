/**
 * Forcefield LIVE RATE detection - catches fast automated agents.
 *
 * An autonomous offensive agent (the 2026-10 Symantec research agent ran up to
 * 100,000 actions per engagement) or a scanner sweeping paths makes requests far
 * faster than a person can click. None of those requests need to look hostile on
 * their own; the RATE is the tell. This module counts requests per client in a
 * short fixed window and reports once when a client crosses the threshold.
 *
 * KEYING + PRIVACY: the key is an FNV-1a hash of (site, client IP, user agent),
 * computed by rateKey and held IN MEMORY ONLY for one window. The IP itself is
 * never stored or forwarded. Keying on the IP (not the hourly session sig, which
 * many visitors on the same browser + country share) keeps a busy site's real
 * visitors from adding up to a false burst.
 *
 * REPORT-ONLY: a rate hit is an observation for the board and the learning loop,
 * never a block on its own (a shared office NAT can be bursty). Per instance:
 * serverless instances each keep their own window, so this under-counts a
 * distributed burst, never over-counts a single client. Bounded memory: at most
 * `maxKeys` entries, oldest evicted first. Pure apart from the module-level map.
 */

export interface RateConfig {
  /** Window length. */
  windowMs: number;
  /** Requests within one window that count as an automated burst. */
  threshold: number;
  /** Hard cap on tracked keys (memory bound). */
  maxKeys: number;
}

/** 40 requests in 10 seconds from one client: well above a person browsing
 *  (a page load's own sub-resources are excluded by the callers, which only count
 *  page/API/probe requests), well below what a sweeping agent produces. */
export const DEFAULT_RATE: RateConfig = { windowMs: 10_000, threshold: 40, maxKeys: 5_000 };

export interface RateHit {
  /** Requests counted in the window at the moment the threshold was crossed. */
  count: number;
  windowMs: number;
  threshold: number;
}

interface Bucket {
  start: number;
  count: number;
  reported: boolean;
}

const _buckets = new Map<string, Bucket>();

/** Test-only: clear all windows. */
export function _resetRateWindow(): void {
  _buckets.clear();
}

/** A non-reversible in-memory key for one client on one site. */
export function rateKey(site: string, ip: string | undefined, userAgent: string): string {
  const s = `${site}|${ip ?? ""}|${userAgent}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Count one request for `key`. Returns a RateHit exactly ONCE per key per window,
 * on the request that crosses the threshold; null otherwise. Never throws.
 */
export function noteRequest(key: string, nowMs: number, cfg: RateConfig = DEFAULT_RATE): RateHit | null {
  try {
    let b = _buckets.get(key);
    if (!b || nowMs - b.start >= cfg.windowMs) {
      if (b) _buckets.delete(key);
      b = { start: nowMs, count: 0, reported: false };
      // Re-insert so Map iteration order stays oldest-first for eviction.
      _buckets.set(key, b);
      while (_buckets.size > cfg.maxKeys) {
        const oldest = _buckets.keys().next().value;
        if (oldest === undefined) break;
        _buckets.delete(oldest);
      }
    }
    b.count++;
    if (!b.reported && b.count >= cfg.threshold) {
      b.reported = true;
      return { count: b.count, windowMs: cfg.windowMs, threshold: cfg.threshold };
    }
    return null;
  } catch {
    return null;
  }
}
