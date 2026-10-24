/**
 * The autonomous watcher: the factory watches its OWN open PRs and drives each one
 * step of the ci-fix loop per tick, so a human is never the poller. Runs on a
 * Vercel cron; walks every enrolled (workspace, repo) TARGET, finds the factory's
 * PRs, and drives them toward merge_ready over successive ticks.
 *
 * Multi-tenant by construction: each target carries its OWN workspace, so the cron
 * drives every client's repos with that client's credentials + entitlement, from a
 * single deployment. Enrolled repos are DB config (watched-repos.ts), not env.
 *
 * Client-safety is by construction, not by option:
 *   - OPT-IN per (workspace, repo): only enrolled targets are ever touched.
 *   - ONLY the AI's own PRs BY DEFAULT: it acts on `factory/*` head branches, OR a
 *     human PR that EXPLICITLY opted in with the `ci-autofix` label. An unlabeled
 *     human branch is never touched (the loop auto-commits, so opt-in is required).
 *   - NEVER auto-merges: it drives to merge_ready and stops; a human approves.
 *   - Bounded + audited: same gate, same attempt budget, every terminal outcome
 *     recorded via ai_code.ci_fix_resolved.
 *   - REMEMBERS (since 2026-10-24): a terminal decision, or a head SHA that has
 *     used its attempt budget, is persisted per (workspace, repo, PR, head SHA)
 *     and never re-driven, and each PR has a per-day drive cap. Before this the
 *     watcher had no memory: from 2026-09-30 it re-drove 8 terminal PRs every
 *     10 minutes, and from 10-08 each re-drive paid for a model call, $241 of
 *     refused completions until a human closed the PRs on 10-18. A new push
 *     changes the SHA, which is the only thing that earns a fresh look.
 *   - PROTECTED PATHS: an authored fix may never edit tests, workflows, the
 *     gate, or build config (PROTECTED_FIX_PATHS, src/lib/ai-code/protected-paths.ts, enforced in ci-fix-runner and the ci-autofix gate).
 *
 * The orchestration is injectable (listPRs, resolveHead, drive, memory) so it is
 * unit-testable without GitHub, a model or a database; the cron route wires the
 * real effects. The factory-branch predicate is REUSED from revert.ts - one
 * definition of "a branch the factory created".
 */
import { isFactoryBranch } from "@/lib/ai-code/revert";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

/** One thing the watcher drives: a repo in a specific workspace. */
export interface WatchTarget {
  workspaceId: string;
  repo: string;
}

export interface WatchPr {
  number: number;
  headRef: string;
  baseRef: string;
  /** PR labels, so a HAND-authored PR can OPT IN to auto-triage. Absent/undefined
   *  => only the factory-branch rule applies (exact prior behavior). */
  labels?: readonly string[];
  /** PR state when the caller knows it. Anything but "open" is never driven. */
  state?: string;
}

/** The opt-in label a human adds to a non-factory PR to request auto-triage. The
 *  loop AUTO-COMMITS fixes, so a human's branch is touched ONLY with this explicit
 *  opt-in - never by default. */
export const AUTOFIX_LABEL = "ci-autofix";

/** A PR the watcher may act on: the AI's own factory branch (always), OR any PR a
 *  human explicitly opted in with the AUTOFIX_LABEL. Anything else is never touched.
 *  Pure - the single eligibility rule, reused by the sweep + the cron wiring. */
export function isAutoTriageEligible(pr: WatchPr): boolean {
  return isFactoryBranch(pr.headRef) || !!pr.labels?.includes(AUTOFIX_LABEL);
}

export interface WatchDriveResult {
  action?: string;
  terminal?: boolean;
}

/** Drives allowed on one unchanged head SHA before it is parked. */
export const MAX_DRIVES_PER_SHA = 3;
/** Drives allowed on one PR per UTC day, across every SHA it has. */
export const DAILY_DRIVE_CAP = 6;

/** The key a decision is remembered under. A new push is a new SHA. */
export interface WatchKey {
  workspaceId: string;
  repo: string;
  pr: number;
  headSha: string;
}

export interface WatchShaState {
  terminal: boolean;
  /** Drives on this SHA that did real work (anything but "wait"). */
  attempts: number;
  lastAction: string | null;
}

/**
 * Where the watcher's memory lives. Injected so the loop is testable without a
 * database; dbWatchMemory() is the production store (migration 293).
 */
export interface WatchMemory {
  get(key: WatchKey): Promise<WatchShaState | null>;
  /** Drives recorded today (UTC) for this PR, across every SHA. */
  dailyAttempts(key: Omit<WatchKey, "headSha">, day: string): Promise<number>;
  /** Record one drive. Returns the state after the write. */
  record(
    key: WatchKey,
    day: string,
    result: { action: string | null; terminal: boolean; counts: boolean },
  ): Promise<{ state: WatchShaState; dailyAttempts: number }>;
}

export type WatchSkipReason =
  | "not_open"
  | "head_unknown"
  | "memory_unavailable"
  | "terminal_unchanged"
  | "sha_attempts_exhausted"
  | "daily_cap";

/**
 * Whether one PR at one SHA may be driven now. Pure: the rule in one place,
 * read before every drive.
 */
export function shouldDrive(input: {
  state: WatchShaState | null;
  dailyAttempts: number;
  maxPerSha?: number;
  dailyCap?: number;
}): { drive: true } | { drive: false; reason: WatchSkipReason } {
  const maxPerSha = input.maxPerSha ?? MAX_DRIVES_PER_SHA;
  const dailyCap = input.dailyCap ?? DAILY_DRIVE_CAP;
  if (input.state?.terminal) return { drive: false, reason: "terminal_unchanged" };
  if ((input.state?.attempts ?? 0) >= maxPerSha) return { drive: false, reason: "sha_attempts_exhausted" };
  if (input.dailyAttempts >= dailyCap) return { drive: false, reason: "daily_cap" };
  return { drive: true };
}

/**
 * Whether a drive result counts against the budgets. "wait" means CI is still
 * running: the step read GitHub and paid for no model call, so it is free and
 * must not park a PR whose checks are merely slow. Everything else (an
 * authored fix, an escalation, merge_ready, an unknown action) counts.
 */
export function driveCounts(action: string | undefined): boolean {
  return action !== "wait";
}

type WatchEvent = "ai.code_watch_parked" | "ai.code_watch_daily_cap_reached";

export interface WatchDeps {
  targets: WatchTarget[];
  /** List a target repo's open PRs (with that workspace's client). */
  listPRs: (target: WatchTarget) => Promise<WatchPr[]>;
  /** The PR's current head SHA. Null or a throw means unknown, and an unknown
   *  head is never driven: without it there is nothing to remember against. */
  resolveHead: (target: WatchTarget, pr: WatchPr) => Promise<string | null>;
  /** Drive ONE ci-fix step for a factory PR in that target's workspace. */
  drive: (target: WatchTarget, pr: WatchPr) => Promise<WatchDriveResult>;
  /** Terminal + attempt memory. Required: a watcher without memory is the loop. */
  memory: WatchMemory;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Analytics sink, injectable for tests. Defaults to trackEvent. */
  track?: (event: WatchEvent, meta: Record<string, string | number | boolean>) => void;
  maxPerSha?: number;
  dailyCap?: number;
}

export interface WatchSummary {
  enabled: boolean;
  driven: Array<{ workspaceId: string; repo: string; pr: number; action?: string; terminal?: boolean }>;
  /** PRs deliberately not driven this tick, and why. */
  skipped: Array<{ workspaceId: string; repo: string; pr: number; reason: WatchSkipReason }>;
  /** factory PRs skipped by a per-PR error, so one bad PR never stalls the sweep. */
  errors: Array<{ workspaceId: string; repo: string; pr: number; error: string }>;
}

const defaultTrack = (event: WatchEvent, meta: Record<string, string | number | boolean>): void =>
  trackEvent(event, "system:ai-code-watch", "system", meta);

/** Run one watcher tick across every enrolled target. Never throws: a target or PR
 *  that errors is recorded and skipped so one failure never stalls the sweep. */
export async function runAiCodeWatch(deps: WatchDeps): Promise<WatchSummary> {
  if (deps.targets.length === 0) return { enabled: false, driven: [], skipped: [], errors: [] };
  const driven: WatchSummary["driven"] = [];
  const skipped: WatchSummary["skipped"] = [];
  const errors: WatchSummary["errors"] = [];
  const track = deps.track ?? defaultTrack;
  const maxPerSha = deps.maxPerSha ?? MAX_DRIVES_PER_SHA;
  const dailyCap = deps.dailyCap ?? DAILY_DRIVE_CAP;
  const day = (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);

  for (const target of deps.targets) {
    let prs: WatchPr[] = [];
    try {
      prs = (await deps.listPRs(target)).filter(isAutoTriageEligible);
    } catch {
      continue; // a target we cannot read is skipped, not fatal
    }
    for (const pr of prs) {
      const where = { workspaceId: target.workspaceId, repo: target.repo, pr: pr.number };
      if (pr.state && pr.state !== "open") {
        skipped.push({ ...where, reason: "not_open" });
        continue;
      }
      let headSha: string | null = null;
      try {
        headSha = await deps.resolveHead(target, pr);
      } catch {
        headSha = null;
      }
      if (!headSha) {
        skipped.push({ ...where, reason: "head_unknown" });
        continue;
      }
      const key: WatchKey = { ...where, headSha };

      /* FAIL CLOSED ON MEMORY. If the watcher cannot read what it decided last
         time, it cannot know it is not repeating itself, and repeating itself
         is the failure this memory exists to prevent. A tick skipped costs
         ten minutes; the loop cost ten days. */
      let gate: ReturnType<typeof shouldDrive>;
      try {
        const [state, daily] = await Promise.all([deps.memory.get(key), deps.memory.dailyAttempts(where, day)]);
        gate = shouldDrive({ state, dailyAttempts: daily, maxPerSha, dailyCap });
      } catch {
        skipped.push({ ...where, reason: "memory_unavailable" });
        continue;
      }
      if (!gate.drive) {
        skipped.push({ ...where, reason: gate.reason });
        continue;
      }

      try {
        const r = await deps.drive(target, pr);
        driven.push({ ...where, action: r.action, terminal: r.terminal });
        const counts = driveCounts(r.action);
        const after = await deps.memory.record(key, day, {
          action: r.action ?? null,
          terminal: r.terminal === true,
          counts,
        });
        /* Events at the TRANSITION only, so a parked PR costs one row, not one
           row per tick (the old loop wrote 20,011 of them). */
        const base = { workspace_id: target.workspaceId, repo: target.repo, pr: pr.number };
        if (r.terminal === true) {
          track("ai.code_watch_parked", {
            ...base, head_sha: headSha, reason: "terminal", action: r.action ?? "unknown", attempts: after.state.attempts,
          });
        } else if (counts && after.state.attempts >= maxPerSha) {
          track("ai.code_watch_parked", {
            ...base, head_sha: headSha, reason: "sha_attempts_exhausted", action: r.action ?? "unknown", attempts: after.state.attempts,
          });
        }
        if (counts && after.dailyAttempts === dailyCap) {
          track("ai.code_watch_daily_cap_reached", { ...base, day, attempts: after.dailyAttempts, cap: dailyCap });
        }
      } catch (e) {
        errors.push({ ...where, error: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return { enabled: true, driven, skipped, errors };
}

/* ---------------------------------------------------------------- memory -- */

/** SQL behind dbWatchMemory, exported so the DB test runs the real statements. */
export const WATCH_SQL = {
  get: `SELECT terminal, attempts, last_action
          FROM instinct_ai_code_watch_state
         WHERE workspace_id = $1 AND repo = $2 AND pr_number = $3 AND head_sha = $4`,
  daily: `SELECT attempts FROM instinct_ai_code_watch_daily
           WHERE workspace_id = $1 AND repo = $2 AND pr_number = $3 AND day = $4::date`,
  /* terminal is sticky: once a SHA is terminal no later write un-terminals it. */
  recordState: `INSERT INTO instinct_ai_code_watch_state
                  (workspace_id, repo, pr_number, head_sha, terminal, attempts, last_action, last_driven_at)
                VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN 1 ELSE 0 END, $7, NOW())
                ON CONFLICT (workspace_id, repo, pr_number, head_sha) DO UPDATE SET
                  terminal = instinct_ai_code_watch_state.terminal OR EXCLUDED.terminal,
                  attempts = instinct_ai_code_watch_state.attempts + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
                  last_action = EXCLUDED.last_action,
                  last_driven_at = NOW()
                RETURNING terminal, attempts, last_action`,
  recordDaily: `INSERT INTO instinct_ai_code_watch_daily (workspace_id, repo, pr_number, day, attempts)
                VALUES ($1, $2, $3, $4::date, CASE WHEN $5::boolean THEN 1 ELSE 0 END)
                ON CONFLICT (workspace_id, repo, pr_number, day) DO UPDATE SET
                  attempts = instinct_ai_code_watch_daily.attempts + CASE WHEN $5::boolean THEN 1 ELSE 0 END
                RETURNING attempts`,
} as const;

type Row = Record<string, unknown>;
type QueryFn = (text: string, params: unknown[]) => Promise<{ rows: Row[] }>;

function toState(row: Row | undefined): WatchShaState | null {
  if (!row) return null;
  return {
    terminal: row.terminal === true,
    attempts: Number(row.attempts ?? 0),
    lastAction: (row.last_action as string | null) ?? null,
  };
}

/**
 * The production memory, backed by migration 293. Uses query(), never
 * safeQuery(): a swallowed read error would read as "never driven", which is
 * exactly the state that produced the loop. Errors propagate and the watcher
 * fails closed on them.
 */
export function dbWatchMemory(run: QueryFn = (t, p) => query(t, p)): WatchMemory {
  return {
    async get(k) {
      const r = await run(WATCH_SQL.get, [k.workspaceId, k.repo, k.pr, k.headSha]);
      return toState(r.rows[0]);
    },
    async dailyAttempts(k, day) {
      const r = await run(WATCH_SQL.daily, [k.workspaceId, k.repo, k.pr, day]);
      return Number(r.rows[0]?.attempts ?? 0);
    },
    async record(k, day, result) {
      const s = await run(WATCH_SQL.recordState, [k.workspaceId, k.repo, k.pr, k.headSha, result.terminal, result.counts, result.action]);
      const d = await run(WATCH_SQL.recordDaily, [k.workspaceId, k.repo, k.pr, day, result.counts]);
      return {
        state: toState(s.rows[0]) ?? { terminal: result.terminal, attempts: result.counts ? 1 : 0, lastAction: result.action },
        dailyAttempts: Number(d.rows[0]?.attempts ?? 0),
      };
    },
  };
}

/** In-process memory with the same semantics, for tests and local runs. */
export function inMemoryWatchMemory(): WatchMemory & { states: Map<string, WatchShaState> } {
  const states = new Map<string, WatchShaState>();
  const daily = new Map<string, number>();
  const sk = (k: WatchKey) => `${k.workspaceId}|${k.repo}|${k.pr}|${k.headSha}`;
  const dk = (k: Omit<WatchKey, "headSha">, day: string) => `${k.workspaceId}|${k.repo}|${k.pr}|${day}`;
  return {
    states,
    async get(k) {
      return states.get(sk(k)) ?? null;
    },
    async dailyAttempts(k, day) {
      return daily.get(dk(k, day)) ?? 0;
    },
    async record(k, day, result) {
      const prev = states.get(sk(k));
      const state: WatchShaState = {
        terminal: (prev?.terminal ?? false) || result.terminal,
        attempts: (prev?.attempts ?? 0) + (result.counts ? 1 : 0),
        lastAction: result.action,
      };
      states.set(sk(k), state);
      const d = (daily.get(dk(k, day)) ?? 0) + (result.counts ? 1 : 0);
      daily.set(dk(k, day), d);
      return { state, dailyAttempts: d };
    },
  };
}

/* Protected paths live in their own pure module so the gates can import the
   list without pulling in the database. Re-exported for existing callers. */
export { PROTECTED_FIX_PATHS, isProtectedFixPath, protectedPathsIn, protectedPathVerdict } from "@/lib/ai-code/protected-paths";
