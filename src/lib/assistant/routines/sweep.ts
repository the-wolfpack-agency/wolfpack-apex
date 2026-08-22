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
import { getTools } from "@/lib/assistant/tools/registry";
import { getAIClient } from "@/lib/ai/router";
import { savePendingAction } from "@/lib/assistant/tools/pending-actions";
import {
  checkRoutine,
  buildRepairPrompt,
  readRepair,
  applyRepairs,
  describeRepairs,
  type Repair,
  type StepProblem,
} from "./heal";
import type { Routine, ToolStep } from "./types";

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

  /* CHECKED BEFORE IT RUNS, not after it fails.
   *
   * The things a chain depends on move underneath it: a tool is renamed, a
   * parameter shape changes, a role changes. Finding that out by running at
   * 8am on a day somebody was counting on it is the worst possible time to
   * find out, and the check is free and deterministic.
   *
   * A broken routine is NOT run. Executing the half of a chain that still
   * works produces a partial answer that looks like a whole one, which is
   * worse than an honest "this needs a decision from you". */
  const health = checkRoutine(routine, getTools(), ctx.userRole);
  if (!health.ok) {
    await proposeRepair(row, routine, health.problems, ctx);
    return "failed";
  }

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

/**
 * Work out what would fix a broken routine, and ask its owner.
 *
 * The repair is never applied here. A chain that rewrites itself is a chain
 * nobody can reason about, and the reason routines are trusted with a mailbox
 * at all is that they do only what they say. So this proposes, through the same
 * confirm-or-cancel path every other action uses, and the person decides.
 *
 * Degrades all the way down: if the model cannot be reached, the proposal is
 * still made from what the deterministic check found, offering to remove the
 * broken steps. Somebody woken by "your routine is broken and here is nothing"
 * has been given a chore rather than an answer.
 */
async function proposeRepair(
  row: ScheduleRow,
  routine: Routine,
  problems: StepProblem[],
  ctx: ToolContext,
): Promise<void> {
  const tools = getTools();
  const repairs: Repair[] = [];

  for (const problem of problems) {
    const step = routine.steps[problem.stepIndex];
    if (!step || step.kind !== "tool") continue;

    /* A permission problem is NOT repairable by swapping tools. Somebody whose
       role changed needs that conversation, and quietly substituting a weaker
       tool would hide a decision the business made on purpose. */
    if (problem.kind === "not_permitted") {
      repairs.push({
        stepIndex: problem.stepIndex,
        action: "drop_step",
        reason: `Your role can no longer run ${problem.tool}, so this step would come out. If that is wrong, it is an access question rather than a routine one.`,
      });
      continue;
    }

    try {
      const res = await getAIClient().complete({
        messages: [
          { role: "user", content: buildRepairPrompt(problem, step as ToolStep, tools) },
        ],
        max_tokens: 200,
        model_tier: "cheap",
        metadata: {
          feature: "assistant.routine_repair",
          user_id: ctx.userId,
          user_role: ctx.userRole,
          ...(ctx.workspaceId ? { workspace_id: ctx.workspaceId } : {}),
        },
      });
      repairs.push(readRepair(res.content, problem, tools, ctx.userRole));
    } catch {
      repairs.push({
        stepIndex: problem.stepIndex,
        action: "drop_step",
        reason: `${problem.detail} I could not work out a replacement, so this step would come out.`,
      });
    }
  }

  if (repairs.length === 0) return;

  const repaired = applyRepairs(routine, repairs);
  await savePendingAction({
    userId: row.userId,
    toolName: "save_routine",
    /* The repaired routine, ready to save under the same command. Saying yes
       replaces it; saying nothing leaves the original alone. */
    params: { routine: repaired, workspaceId: row.workspaceId },
    description: `Repair "${routine.command}"`,
  }).catch(() => undefined);

  trackEvent("assistant.routine_repair_proposed", row.userId, ctx.userRole, {
    routine_id: routine.id,
    workspace_id: row.workspaceId,
    problems: problems.length,
    /* Which kinds break in the field, so the next thing to make robust is a
       query rather than a guess. */
    kinds: [...new Set(problems.map((p) => p.kind))].sort().join(","),
    dropped: repairs.filter((r) => r.action === "drop_step").length,
    replaced: repairs.filter((r) => r.action === "replace_tool").length,
  });

  await notifyQuietly({
    userId: row.userId,
    category: "system",
    priority: "normal",
    title: `${routine.command} needs a decision`,
    body: describeRepairs(routine, repairs).slice(0, 1200),
    actionUrl: "/assistant",
    actionLabel: "Review the fix",
    source: "routine_repair_proposed",
    sourceId: `${row.id}:${routine.steps.length}`,
    dedup: true,
  });
}
