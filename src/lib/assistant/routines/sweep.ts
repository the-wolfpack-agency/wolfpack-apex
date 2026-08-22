/**
 * Running the routines that are due, and telling people what happened.
 *
 * WHAT AN UNATTENDED RUN IS ALLOWED TO DO
 *
 * The same as an attended one, which is the point: it gathers, it reasons over
 * what it gathered, and it stops at the first step that needs a person. It
 * cannot send, file or tell anybody anything, because every write tool still
 * requires confirmation and there is nobody present to give it.
 *
 * That property is what makes this safe to offer. The worst outcome of a
 * scheduled run going wrong is a brief nobody reads. It is not an email nobody
 * meant to send.
 *
 * ONE NOTIFICATION, WITH THE ANSWER IN IT
 *
 * A notification saying "your routine ran" is a second errand: the person still
 * has to go and look. The answer travels with it, so a brief that ran at 7am is
 * readable at 7:01 without opening anything.
 */
import { notify } from "@/lib/notifications/in-app";
import { trackEvent } from "@/lib/analytics";
import { matchRoutine } from "./catalogue";
import { matchSavedRoutine } from "./saved";
import { runRoutine, describeRun } from "./index";
import { dueSchedules, recordRun, MAX_CONSECUTIVE_FAILURES, type ScheduleRow } from "./schedule-store";
import { describeSchedule } from "./schedule";
import type { ToolContext } from "@/lib/assistant/tools/types";

export interface SweepResult {
  due: number;
  ran: number;
  waiting: number;
  failed: number;
  deactivated: number;
}

/**
 * Run everything due.
 *
 * One routine failing must never stop the pass: a sweep that abandons its work
 * at the first bad row means one person's broken schedule silently cancels
 * everybody else's morning.
 */
export async function sweepDueRoutines(now: Date = new Date()): Promise<SweepResult> {
  const rows = await dueSchedules(now);
  const result: SweepResult = { due: rows.length, ran: 0, waiting: 0, failed: 0, deactivated: 0 };

  for (const row of rows) {
    try {
      const outcome = await runOne(row, now);
      if (outcome === "waiting") result.waiting += 1;
      if (outcome !== "failed") result.ran += 1;
      else result.failed += 1;
      const { deactivated } = await recordRun(row, outcome === "failed" ? "failed" : "ok", now);
      if (deactivated) {
        result.deactivated += 1;
        await tellThemItStopped(row);
      }
    } catch {
      /* Already counted as failed by runOne where it could be; this catch is
         the backstop that keeps one row from ending the pass. */
      result.failed += 1;
    }
  }

  return result;
}

async function runOne(row: ScheduleRow, now: Date): Promise<"done" | "waiting" | "failed"> {
  /* THE ROUTINE IS RESOLVED AT RUN TIME, not stored on the schedule. Somebody
     who re-saves a chain under the same command expects tomorrow's run to use
     the new version, and a copy taken when the schedule was made would quietly
     keep running the old one. */
  const owner = { workspaceId: row.workspaceId, userId: row.userId };
  const routine = matchRoutine(row.command) ?? (await matchSavedRoutine(owner, row.command));

  if (!routine) {
    /* The chain was deleted or renamed. Said plainly, because the fix is
       theirs and a schedule pointing at nothing would otherwise fail forever
       with no explanation. */
    await notifyQuietly({
      userId: row.userId,
      category: "system",
      priority: "normal",
      title: "A scheduled routine no longer exists",
      body: `"${row.command}" is scheduled ${describeSchedule(row.schedule)}, but there is no routine by that name any more. Save it again or cancel the schedule.`,
      source: "routine_schedule_missing",
      sourceId: row.id,
      dedup: true,
    });
    return "failed";
  }

  /* The person's own identity and role are not available to a cron process, so
     the run is made as the owner with the least privilege that still works.
     Every tool re-checks the gate itself, so a step they could not run
     interactively cannot run here either. */
  const ctx: ToolContext = {
    userId: row.userId,
    userRole: "member",
    workspaceId: row.workspaceId,
  };

  const run = await runRoutine(routine, ctx, `sched:${row.id}:${now.getTime()}`);

  if (run.state === "failed") {
    const failed = run.outcomes.find((o) => o.status === "failed");
    await notifyQuietly({
      userId: row.userId,
      category: "system",
      priority: "normal",
      title: `${routine.command} could not finish`,
      body: `It stopped at "${failed?.label ?? "a step"}": ${failed?.error ?? "the step did not complete"}.`,
      source: "routine_schedule_failed",
      sourceId: `${row.id}:${now.toISOString().slice(0, 10)}`,
      dedup: true,
    });
    return "failed";
  }

  const waiting = run.state === "waiting_for_human";
  await notifyQuietly({
    userId: row.userId,
    category: "system",
    priority: "normal",
    title: waiting ? `${routine.command} is ready and waiting on you` : `${routine.command} has run`,
    /* The answer travels with the notification. Otherwise this is a second
       errand: go and look at the thing that was supposed to save you time. */
    body: describeRun(routine, run).slice(0, 1200),
    actionUrl: "/assistant",
    actionLabel: waiting ? "Pick it up" : "Open",
    source: "routine_schedule_ran",
    sourceId: `${row.id}:${now.toISOString().slice(0, 13)}`,
    dedup: true,
  });

  trackEvent("assistant.routine_advanced", row.userId, "member", {
    routine_id: routine.id,
    run_id: run.runId,
    workspace_id: row.workspaceId,
    state: run.state,
    steps_done: run.outcomes.filter((o) => o.status === "ok").length,
    tech_ms: run.techMs,
    human_ms: run.humanMs,
    tool_steps: run.outcomes.filter((o) => o.kind === "tool").length,
    model_steps: run.outcomes.filter((o) => o.kind === "model").length,
    /* Which runs nobody asked for in the moment. A scheduled run that is never
       picked up is a standing appointment worth questioning. */
    scheduled: true,
  });

  return waiting ? "waiting" : "done";
}

async function tellThemItStopped(row: ScheduleRow): Promise<void> {
  await notifyQuietly({
    userId: row.userId,
    category: "system",
    priority: "normal",
    title: "A scheduled routine has been switched off",
    body: `"${row.command}" failed ${MAX_CONSECUTIVE_FAILURES} times in a row, so I have stopped running it ${describeSchedule(row.schedule)}. Nothing else has changed, and you can still run it by name.`,
    source: "routine_schedule_stopped",
    sourceId: row.id,
    dedup: true,
  });
}

/** A notification that fails must not fail the run it was reporting on. */
async function notifyQuietly(input: Parameters<typeof notify>[0]): Promise<void> {
  try {
    await notify(input);
  } catch {
    /* The work still happened. */
  }
}
