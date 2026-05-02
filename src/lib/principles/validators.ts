/**
 * Validator framework — maps Hoxsie's plain-English Signal/Counter-
 * signal lines to code-defined evaluators that read existing data
 * sources (calendar, mail, tasks, goals, code) and emit Observations.
 *
 * Design:
 *   - Each Validator is a pure registry entry: { id, surface,
 *     describe, matches, evaluate }. No network or DB at registration
 *     time — the cron job calls evaluate() on schedule.
 *   - matches(description) is the bridge between human prose and
 *     mechanical evaluation. It's a simple keyword test; tightening
 *     this is one of the easiest things Hoxsie + Nick can iterate on.
 *   - evaluate(ctx) returns Observation[] with the uniform evidence
 *     schema so the scoreboard / morning briefing don't care which
 *     surface produced which row.
 *
 * Zero LLM tokens — all matching + evaluation is pure code (per the
 * global zero-tokens-first invariant).
 */

export interface EvaluationContext {
  /** ISO date for the start of the evaluation window. Validators use
   *  this to scope queries. Defaults to last 7 days at the cron site. */
  windowStart: string;
  /** ISO date for end of window — usually now. */
  windowEnd: string;
  /** Optional user filter — when set, validators scope to this user. */
  subjectUserId?: string;
}

export interface Observation {
  surface: string;
  surfaceSubtype?: string;
  subjectUserId?: string;
  observedAt: string;
  /** -1..1; negative = drift from principle, positive = adherence. */
  score: number;
  evidence: {
    kind: string;
    sourceId?: string;
    sourceUrl?: string;
    metric?: { name: string; value: number | string };
    notes?: string;
  };
}

export interface Validator {
  /** Stable id (e.g. 'calendar.focus_block_ratio'). Stored in
   *  instinct_principle_signals.validator_id to bind a Signal to its
   *  evaluator. */
  id: string;
  surface:
    | "calendar"
    | "mail"
    | "teams"
    | "tasks"
    | "goals"
    | "docs"
    | "code"
    | "devops"
    | "cost"
    | "identity"
    | "security";
  /** Human-readable name shown on the /principles UI. */
  describe: string;
  /** Decide whether a Signal/Counter-signal description maps to this
   *  validator. Default: case-insensitive keyword test. */
  matches: (description: string) => boolean;
  /** Run the evaluator against the configured surface and return
   *  observations. Must NOT throw on data-source errors — return [] +
   *  log instead. The cron job catches anything that escapes. */
  evaluate: (ctx: EvaluationContext) => Promise<Observation[]>;
  /** When true, the validator runs ONCE per cron firing (not per user)
   *  and emits observations with `subject_user_id = null`. Used for
   *  signals where the underlying data is org-wide (every active KR,
   *  every team PR) and per-member fan-out would inflate counts +
   *  flatten the per-member mean by attributing the same row to
   *  everyone. The /principles team scoreboard renders these as a
   *  "team" lane separate from per-member rows. */
  teamWide?: boolean;
}

/* ------------------------------------------------------------------ */
/* Time helpers used by rollup evaluators                              */
/* ------------------------------------------------------------------ */

/**
 * Snap an ISO timestamp to UTC midnight of the same date. Rollup
 * evaluators (one observation per day, per week, per series) call this
 * so two cron firings 15 seconds apart produce the SAME observed_at —
 * which combined with the migration-122 UNIQUE index makes the insert
 * naturally idempotent via ON CONFLICT DO NOTHING.
 *
 * Pure for unit testing. Returns the input unchanged on parse failure
 * so a malformed string never crashes the cron.
 */
export function snapToUtcDay(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/* Org timezone — Wolfpack is based in Dallas, TX. Calendar / mail    */
/* evaluators anchor business-hours + after-hours windows to this     */
/* zone instead of UTC (Vercel server time). Override via env for     */
/* tests or future relocation.                                         */
/* ------------------------------------------------------------------ */

export const ORG_TZ = process.env.INSTINCT_ORG_TZ || "America/Chicago";

/**
 * Wall-clock hour (0-23) at the given timezone for a UTC ISO string.
 * Falls back to UTC hour on parse / tz failure.
 */
export function localHourInTz(iso: string, tz: string = ORG_TZ): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz || "UTC",
    });
    const parts = fmt.formatToParts(new Date(iso));
    const hourPart = parts.find((p) => p.type === "hour");
    const n = hourPart ? Number(hourPart.value) : Number.NaN;
    if (Number.isFinite(n)) return n === 24 ? 0 : n;
  } catch {
    /* fall through */
  }
  return new Date(iso).getUTCHours();
}

/**
 * Return the calendar date (YYYY-MM-DD) at the given timezone for a
 * UTC ISO string. Used by daily-rollup evaluators that bucket events
 * by Dallas calendar day, not UTC day.
 */
export function dayDateInTz(iso: string, tz: string = ORG_TZ): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz || "UTC",
    });
    return fmt.format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Return the UTC ISO string for midnight on the given calendar date in
 * the given timezone. The result is a stable "day key" — repeated
 * cron firings on the same Dallas day produce identical observed_at.
 */
export function snapToOrgDay(iso: string, tz: string = ORG_TZ): string {
  const dayDate = dayDateInTz(iso, tz);
  /* Construct a Date at midnight in the target tz: parse YYYY-MM-DD as
     UTC, then offset by the tz offset for that date. We compute the
     offset by formatting the same instant in both UTC and the target
     tz and diffing. Robust across DST transitions. */
  const utcMidnightMs = Date.parse(`${dayDate}T00:00:00Z`);
  if (!Number.isFinite(utcMidnightMs)) return iso;
  /* Find the offset (minutes) at this date by formatting noon UTC in
     the target tz and reading back the wall-clock hour. */
  const probeMs = utcMidnightMs + 12 * 60 * 60 * 1000; // noon UTC
  const wallHour = localHourInTz(new Date(probeMs).toISOString(), tz);
  /* If wallHour < 12, the tz is west of UTC; offset = -(12 - wallHour).
     If >= 12, east; offset = wallHour - 12. */
  const offsetHours = wallHour < 12 ? -(12 - wallHour) : wallHour - 12;
  const orgMidnightMs = utcMidnightMs - offsetHours * 60 * 60 * 1000;
  return new Date(orgMidnightMs).toISOString();
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const REGISTRY: Validator[] = [];

export function registerValidator(v: Validator): void {
  if (REGISTRY.find((x) => x.id === v.id)) {
    throw new Error(`Validator already registered: ${v.id}`);
  }
  REGISTRY.push(v);
}

export function listValidators(): readonly Validator[] {
  return REGISTRY;
}

export function findValidatorForDescription(
  description: string,
): Validator | null {
  for (const v of REGISTRY) {
    if (v.matches(description)) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Helpers used by validators                                          */
/* ------------------------------------------------------------------ */

/** Normalize a description for matching: lowercase, collapse spaces,
 *  drop common stopwords. Keeps it simple and fast. */
export function normalizeDesc(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9< >]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a `matches` function that requires every keyword in the list
 *  to appear in the normalized description. */
export function keywordMatcher(...keywords: string[]): Validator["matches"] {
  return (description: string) => {
    const norm = normalizeDesc(description);
    return keywords.every((k) => norm.includes(k.toLowerCase()));
  };
}

/* ------------------------------------------------------------------ */
/* TEST HOOK — clear the registry between tests so re-registering      */
/* validators in beforeEach doesn't throw. Not exported in production. */
/* ------------------------------------------------------------------ */
export function _resetRegistryForTests(): void {
  REGISTRY.length = 0;
}
