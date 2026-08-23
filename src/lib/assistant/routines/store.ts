/**
 * Persisting a run, for the one thing that cannot be reconstructed later.
 *
 * A run's steps are visible while it happens and its results are already in
 * the chat. What is NOT recoverable afterwards is where the time went: which
 * step the machine did in 300ms, and which step sat waiting eleven minutes for
 * a person. See migration 232 for why those two columns are the reason this
 * table exists.
 *
 * WHAT NEVER REACHES THIS FILE
 *
 * Slot contents. A run carries mail bodies, customer history and draft replies
 * between its steps; a table of those is a second copy of the mailbox without
 * any of the controls the mailbox has. Steps are recorded by label, status and
 * duration. Not by what they were carrying.
 *
 * NEVER THROWS
 *
 * A routine that fails because its bookkeeping failed is strictly worse than
 * one that ran and was not measured. Every function here reports and returns.
 */
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { RoutineRun } from "./types";

/** Write or update the run and its steps. Best effort, by design. */
export async function saveRun(run: RoutineRun): Promise<void> {
  try {
    await query(
      `INSERT INTO assistant_routine_runs
         (run_id, routine_id, user_id, workspace_id, state, step_cursor, tech_ms, human_ms, paused_at, finished_at, answers, pending_ask)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET
         state       = EXCLUDED.state,
         step_cursor = EXCLUDED.step_cursor,
         tech_ms     = EXCLUDED.tech_ms,
         human_ms    = EXCLUDED.human_ms,
         paused_at   = EXCLUDED.paused_at,
         finished_at = EXCLUDED.finished_at,
         answers     = EXCLUDED.answers,
         pending_ask = EXCLUDED.pending_ask`,
      [
        run.runId,
        run.routineId,
        run.userId,
        run.workspaceId,
        run.state,
        run.cursor,
        run.techMs,
        run.humanMs,
        run.pausedAt ? new Date(run.pausedAt) : null,
        run.state === "done" || run.state === "failed" ? new Date() : null,
        JSON.stringify(run.answers ?? {}),
        run.pendingAsk ? JSON.stringify(run.pendingAsk) : null,
      ],
    );

    /* Steps are rewritten rather than appended: a human step is recorded once
       as "waiting" and again as "ok" with the wait on it, and two rows for one
       step would double every count built on this table. */
    for (const o of run.outcomes) {
      await query(
        `INSERT INTO assistant_routine_steps
           (run_id, workspace_id, step_index, kind, tool, label, status, duration_ms, error, human_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (run_id, step_index) DO UPDATE SET
           status       = EXCLUDED.status,
           duration_ms  = EXCLUDED.duration_ms,
           error        = EXCLUDED.error,
           human_action = EXCLUDED.human_action`,
        [
          run.runId,
          run.workspaceId,
          o.index,
          o.kind,
          /* The tool name is on the routine, not the outcome; recorded as null
             here rather than guessed, because a wrong tool name in this table
             would send somebody hunting the wrong step. */
          null,
          o.label,
          o.status,
          o.durationMs,
          o.error ?? null,
          o.action ?? null,
        ],
      );
    }
  } catch {
    /* A run that completed and was not measured is a lost data point. A run
       that FAILED because its bookkeeping failed is a lost morning. */
  }
}

/** Announce a state change, so the learning loop sees chains as well as tools. */
export function trackRun(run: RoutineRun, userRole: string): void {
  trackEvent("assistant.routine_advanced", run.userId, userRole, {
    routine_id: run.routineId,
    run_id: run.runId,
    workspace_id: run.workspaceId,
    state: run.state,
    steps_done: run.outcomes.filter((o) => o.status === "ok").length,
    /* HOW MUCH OF THIS NEEDED A MODEL AT ALL.
       The claim being made to a client is that their tools are being operated
       from one place and the AI is used only where judgement is actually
       required. That claim should be a measurement rather than a sentence in a
       deck: a routine that runs six steps and calls a model once is a fact
       these two counters can produce on demand, per routine, per week. It is
       also the honest early-warning signal if a chain quietly drifts into
       asking a model things a tool already knows. */
    tool_steps: run.outcomes.filter((o) => o.kind === "tool").length,
    model_steps: run.outcomes.filter((o) => o.kind === "model").length,
    /* Both numbers, always, including the zeroes. A routine nobody waits on is
       as interesting as one they do, and it only shows up as a zero. */
    tech_ms: run.techMs,
    human_ms: run.humanMs,
    ...(run.state === "failed"
      ? { failed_step: run.outcomes[run.outcomes.length - 1]?.label ?? "unknown" }
      : {}),
  });
}

export interface RunSummary {
  runId: string;
  routineId: string;
  state: string;
  startedAt: string;
  techMs: number;
  humanMs: number;
  steps: number;
  /** The step it is sitting on, when it is waiting on somebody. */
  waitingOn: string | null;
}

/**
 * This person's recent runs.
 *
 * Ordered newest first and bounded, because the value of this list is "what
 * happened lately and what is waiting on me", and a year of history answers
 * neither question while costing more to read.
 */
export async function listRecentRuns(
  owner: { workspaceId: string; userId: string },
  limit = 20,
): Promise<RunSummary[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<Record<string, unknown>>(
      `SELECT r.run_id, r.routine_id, r.state, r.started_at, r.tech_ms, r.human_ms,
              COUNT(s.step_index)                                        AS steps,
              MAX(s.label) FILTER (WHERE s.status = 'waiting')           AS waiting_on
         FROM assistant_routine_runs r
    LEFT JOIN assistant_routine_steps s ON s.run_id = r.run_id
        WHERE r.workspace_id = $1 AND r.user_id = $2
     GROUP BY r.run_id, r.routine_id, r.state, r.started_at, r.tech_ms, r.human_ms
     ORDER BY r.started_at DESC
        LIMIT $3`,
      [owner.workspaceId, owner.userId, Math.min(Math.max(limit, 1), 50)],
    );
    return rows.map((r) => ({
      runId: String(r.run_id),
      routineId: String(r.routine_id),
      state: String(r.state),
      startedAt: new Date(String(r.started_at)).toISOString(),
      techMs: Number(r.tech_ms) || 0,
      humanMs: Number(r.human_ms) || 0,
      steps: Number(r.steps) || 0,
      waitingOn: r.waiting_on === null || r.waiting_on === undefined ? null : String(r.waiting_on),
    }));
  } catch {
    return [];
  }
}

/**
 * The run this person is being asked about, if any.
 *
 * Bounded to the last two hours. A routine that stopped for somebody yesterday
 * is not something they are still in the middle of, and treating a fresh
 * "done" as an answer to it would resume a chain they have forgotten agreeing
 * to.
 *
 * SLOTS ARE NOT STORED, by the decision in migration 232: they carry mail
 * bodies and draft replies between steps, and a table of those is a second
 * copy of the mailbox without the mailbox's controls. So a resumed run has the
 * outcomes and the cursor and no slot values, and the caller has to cope with
 * that rather than pretend otherwise.
 */
export async function loadWaitingRun(owner: {
  workspaceId: string;
  userId: string;
}): Promise<(RoutineRun & { pausedAt: number | null }) | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<Record<string, unknown>>(
      `SELECT run_id, routine_id, state, step_cursor, tech_ms, human_ms, paused_at, answers, pending_ask
         FROM assistant_routine_runs
        WHERE workspace_id = $1 AND user_id = $2
          AND state = 'waiting_for_human'
          AND started_at > NOW() - INTERVAL '2 hours'
        ORDER BY started_at DESC
        LIMIT 1`,
      [owner.workspaceId, owner.userId],
    );
    const r = rows[0];
    if (!r) return null;

    /* SCOPED ON ITS OWN TERMS, not on the caller having scoped the parent.
       The run_id above came from a workspace-filtered query, so this is safe
       today; it is filtered anyway because that is the argument for carrying
       workspace_id on this table at all, and the repo's isolation scan holds
       every query to it. */
    const steps = await query<Record<string, unknown>>(
      `SELECT step_index, kind, label, status, duration_ms, error, human_action
         FROM assistant_routine_steps
        WHERE run_id = $1 AND workspace_id = $2
        ORDER BY step_index`,
      [String(r.run_id), owner.workspaceId],
    );

    return {
      runId: String(r.run_id),
      routineId: String(r.routine_id),
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      state: "waiting_for_human",
      cursor: Number(r.step_cursor) || 0,
      outcomes: steps.rows.map((s) => ({
        index: Number(s.step_index),
        kind: String(s.kind) as "tool" | "model" | "human",
        label: String(s.label),
        status: String(s.status) as "ok" | "failed" | "skipped" | "waiting",
        durationMs: Number(s.duration_ms) || 0,
        ...(s.error ? { error: String(s.error) } : {}),
        ...(s.human_action ? { action: String(s.human_action) as "review" | "do" } : {}),
      })),
      slots: {},
      answers:
        r.answers && typeof r.answers === "object"
          ? (r.answers as Record<string, string>)
          : {},
      pendingAsk:
        r.pending_ask && typeof r.pending_ask === "object"
          ? (r.pending_ask as { stepIndex: number; key: string; question: string })
          : null,
      techMs: Number(r.tech_ms) || 0,
      humanMs: Number(r.human_ms) || 0,
      pausedAt: r.paused_at ? new Date(String(r.paused_at)).getTime() : null,
    };
  } catch {
    return null;
  }
}
