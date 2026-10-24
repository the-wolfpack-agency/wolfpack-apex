/**
 * Evidence windows: the one primitive every status surface derives from.
 *
 * A status shown to anyone (the Forcefield assurance panel, the compliance
 * crosswalk, the security-posture parity check) must come from evidence that the
 * control EXECUTED recently: an event row, a check run, or a sample run through
 * the real code. Configuration alone is never evidence. This module turns one
 * read-only query ("how many proof rows in the window, and when was the last
 * one") into a classified probe:
 *
 *   fresh  - at least one proof row inside the freshness window
 *   stale  - proof exists, but the newest row is older than the window
 *   none   - no proof row at all in the lookback
 *   error  - the query failed or no database is configured (UNKNOWN, never active)
 *
 * Pure classification lives here so it is unit-testable without a database; the
 * query runner takes an injected executor so the routes use the real pool and
 * the tests use a fake.
 */

export type EvidenceState = "fresh" | "stale" | "none" | "error";

export interface EvidenceProbe {
  /** Stable key a claim or control references (e.g. "ff.inline_block"). */
  key: string;
  /** Plain-language statement of what proves the control ran. */
  proof: string;
  /** Freshness window in days. */
  windowDays: number;
  /** Proof rows inside the window. */
  count: number;
  /** Newest proof row seen in the lookback (ISO), or null. */
  lastAt: string | null;
  state: EvidenceState;
  /** Set when state is "error". Never contains query parameters or secrets. */
  error?: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Classify a probe from its raw count + newest timestamp. Pure. */
export function classifyEvidence(
  countInWindow: number,
  lastAt: string | null,
  windowDays: number,
  nowMs: number,
): Exclude<EvidenceState, "error"> {
  if (countInWindow > 0) {
    // Defensive: a count with a newest row older than the window means the
    // query and the window disagree. Trust the timestamp, not the count.
    const t = lastAt ? new Date(lastAt).getTime() : NaN;
    if (Number.isFinite(t) && nowMs - t > windowDays * DAY_MS) return "stale";
    return "fresh";
  }
  return lastAt ? "stale" : "none";
}

/** Build an error probe. The message is reduced to its first line and capped,
 *  so a driver error never leaks a connection string into an API response. */
export function errorProbe(key: string, proof: string, windowDays: number, err: unknown): EvidenceProbe {
  const raw = err instanceof Error ? err.message : String(err ?? "unknown error");
  const msg = raw.split("\n")[0].replace(/postgres(ql)?:\/\/\S+/gi, "[redacted-url]").slice(0, 160);
  return { key, proof, windowDays, count: 0, lastAt: null, state: "error", error: msg };
}

/** The minimal executor a probe needs. Throws on failure (unlike safeQuery,
 *  which swallows errors and would make a broken table read as "none"). */
export type EvidenceExecutor = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface ProbeSpec {
  key: string;
  proof: string;
  windowDays: number;
  /** Lookback for "stale vs none" (days). Defaults to 90. */
  lookbackDays?: number;
  /**
   * SQL that returns ONE row with columns `n` (count inside the window) and
   * `last` (newest proof timestamp inside the lookback). It receives
   * `$1` = window days, `$2` = lookback days, then `params`.
   */
  sql: string;
  params?: unknown[];
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Run one probe. Never throws: a failure is an "error" probe (unknown). */
export async function runEvidenceProbe(
  spec: ProbeSpec,
  exec: EvidenceExecutor | null,
  nowMs: number = Date.now(),
): Promise<EvidenceProbe> {
  if (!exec) return errorProbe(spec.key, spec.proof, spec.windowDays, "no database configured");
  const lookback = spec.lookbackDays ?? 90;
  try {
    const res = await exec(spec.sql, [String(spec.windowDays), String(lookback), ...(spec.params ?? [])]);
    const row = res.rows[0] ?? {};
    const n = Number(row.n ?? 0);
    const count = Number.isFinite(n) ? n : 0;
    const lastAt = toIso(row.last);
    return { key: spec.key, proof: spec.proof, windowDays: spec.windowDays, count, lastAt, state: classifyEvidence(count, lastAt, spec.windowDays, nowMs) };
  } catch (err) {
    return errorProbe(spec.key, spec.proof, spec.windowDays, err);
  }
}

/** A probe computed in-process (a sample run through the real code). Always
 *  fresh when it passed, because it ran in this request. */
export function sampleProbe(key: string, proof: string, passed: boolean, nowMs: number = Date.now()): EvidenceProbe {
  return {
    key,
    proof,
    windowDays: 0,
    count: passed ? 1 : 0,
    lastAt: passed ? new Date(nowMs).toISOString() : null,
    state: passed ? "fresh" : "none",
  };
}

/** Human summary of a probe for a status line. */
export function describeProbe(p: EvidenceProbe): string {
  switch (p.state) {
    case "fresh":
      return p.windowDays > 0 ? `${p.count} in the last ${p.windowDays}d` : "passed in this request";
    case "stale":
      return `none in the last ${p.windowDays}d; last seen ${p.lastAt?.slice(0, 10) ?? "unknown"}`;
    case "none":
      return p.windowDays > 0 ? `never seen (window ${p.windowDays}d)` : "did not pass";
    case "error":
      return `could not be measured (${p.error ?? "error"})`;
  }
}
