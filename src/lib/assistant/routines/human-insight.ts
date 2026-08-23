/**
 * What the human steps are telling you about the week.
 *
 * A routine records two things nothing else in the estate holds: whether a
 * person did the part only they could do, and how long it took them. This turns
 * those rows into something somebody can act on.
 *
 * WHY THE RECOMMENDATION LIVES IN CODE AND NOT IN SQL
 *
 * The counts are arithmetic and belong in a view. The reading of them is a
 * judgement, and a judgement frozen into a database view is one nobody reviews
 * again. Here it can be read, argued with, and changed when it turns out to be
 * wrong.
 *
 * WHAT IT REFUSES TO DO
 *
 * It does not score people. Every sentence below is about a STEP: whether it is
 * earning its place in the routine, whether software could carry part of it,
 * whether it is being skipped often enough to be worth a conversation. A
 * product that turns "skipped the rehearsal three times" into a mark against
 * somebody gets one of two responses, and both destroy the data: people stop
 * running routines, or they tick the box without doing the thing.
 *
 * Pure: rows in, findings out. No clock, no I/O.
 */
import type { HumanAction } from "./types";

export interface HumanStepRow {
  routineId: string;
  stepIndex: number;
  label: string;
  humanAction: HumanAction;
  asked: number;
  completed: number;
  skipped: number;
  /** Average milliseconds on the runs where it was actually done. */
  avgMsWhenDone: number | null;
  /**
   * The FASTEST it has ever been done, in milliseconds.
   *
   * The closest honest proxy for how long the work itself takes. Elapsed time
   * from being asked to being done includes however long somebody left it, and
   * the run where they left it least is the run where the number is mostly
   * work. A step whose average is an hour and whose best is four minutes is
   * not an hour of effort; it is four minutes that waits an hour.
   */
  fastestMs?: number | null;
}

export type HumanFindingKind =
  /**
   * Consistently done, and consistently a long time after it was offered.
   *
   * The finding nobody else produces, and the one the whole design is for. A
   * step that is always picked up hours late is not a step somebody is slow
   * at: it is a step in the wrong place in their day. Preparation done after
   * the thing it was for is preparation that did not happen, and a call made
   * at five for a decision needed at ten is a decision made without it.
   *
   * Kept separate from "expensive" on purpose. Elapsed time from being asked
   * to being done is latency AND work together, and we cannot split them
   * without asking. What we can say honestly is which of those two shapes the
   * number has: a step done every time, quickly once started, but always
   * started late, is a scheduling problem rather than an effort problem, and
   * the fix is different.
   */
  | "left_late"
  /** Consistently done, quickly, and nobody changes anything. The pause is
   *  costing more than it is catching. */
  | "pause_not_earning"
  /** Done every time and slow. The person is carrying something software
   *  could carry part of. */
  | "worth_a_tool"
  /** Asked for repeatedly and repeatedly not done. */
  | "not_happening"
  /** Working as intended. Reported, because a routine where everything is
   *  fine should say so rather than going quiet. */
  | "healthy";

export interface HumanFinding {
  routineId: string;
  stepIndex: number;
  label: string;
  kind: HumanFindingKind;
  /** What is happening, in numbers the reader can check. */
  observation: string;
  /** What to consider doing. A suggestion, never an instruction. */
  suggestion: string;
  completionRate: number;
}

/** Below this, a step is being asked for and not done. */
const SKIPPED_A_LOT = 0.5;
/** Above this, a step is habitual. */
const NEARLY_ALWAYS = 0.9;
/** Long enough that carrying it by hand is worth naming. Five minutes. */
const SLOW_MS = 5 * 60 * 1000;
/**
 * How much bigger the average must be than the best run before the number is
 * mostly waiting rather than working.
 *
 * Four, deliberately not two. Somebody having one quick run and one slow one
 * is ordinary variance; an average four times the best is a step that sits
 * untouched most days, and that is a different conversation.
 */
const LATENCY_RATIO = 4;
/** Under a minute, a review is a glance. */
const GLANCE_MS = 60 * 1000;
/**
 * Fewer runs than this and there is nothing to say.
 *
 * The most damaging thing this file could do is turn one skipped rehearsal into
 * a finding. Somebody who ran a routine twice deserves silence, not a chart.
 */
export const MIN_RUNS_FOR_A_FINDING = 5;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

/**
 * Read the rows.
 *
 * Ordered by how much attention each finding deserves: work that is not
 * happening first, then steps a tool could help with, then pauses that are not
 * earning their place, then the healthy ones.
 */
export function readHumanSteps(rows: HumanStepRow[]): HumanFinding[] {
  const findings: HumanFinding[] = [];

  for (const r of rows) {
    if (r.asked < MIN_RUNS_FOR_A_FINDING) continue;
    const rate = r.asked === 0 ? 0 : r.completed / r.asked;
    const avg = r.avgMsWhenDone ?? 0;
    const base = { routineId: r.routineId, stepIndex: r.stepIndex, label: r.label, completionRate: rate };

    if (rate < SKIPPED_A_LOT) {
      /* THE FINDING THAT MATTERS MOST, and the one to state carefully. Two
         readings fit the same number and only the person knows which is true,
         so the suggestion offers both rather than picking. */
      findings.push({
        ...base,
        kind: "not_happening",
        observation: `Asked ${r.asked} times, done ${r.completed}. It is skipped more often than not.`,
        suggestion:
          r.humanAction === "do"
            ? "Either this is not as important as the routine assumes, in which case take it out, or it matters and is not getting done, which is worth a conversation rather than a reminder."
            : "A checkpoint this often skipped is not checking anything. Either the step before it is trusted, in which case remove the pause, or the review is happening somewhere else.",
        });
      continue;
    }

    /* LEFT LATE, checked BEFORE expensive.
     *
     * The two look identical in the average and mean opposite things. A step
     * that takes forty minutes every time is expensive. A step that takes four
     * minutes when somebody finally gets to it, an hour after being asked, is
     * not expensive at all: it is late, and the fix is where it sits in the
     * day rather than what it costs.
     *
     * The fastest run is the tell. If somebody has ever done this in a small
     * fraction of the average, the average is mostly waiting. */
    const fastest = r.fastestMs ?? null;
    if (
      r.humanAction === "do" &&
      rate >= NEARLY_ALWAYS &&
      avg >= SLOW_MS &&
      fastest !== null &&
      fastest * LATENCY_RATIO <= avg
    ) {
      findings.push({
        ...base,
        kind: "left_late",
        observation: `Done on ${pct(rate)} of runs. Usually about ${minutes(avg)} minutes from being asked to being done, but as little as ${minutes(fastest)} minutes when you get to it straight away.`,
        suggestion:
          "That gap is waiting rather than work. Preparation done after the thing it was for did not happen, so it is worth asking whether this belongs earlier in the day, or whether the routine should arrive later.",
      });
      continue;
    }

    if (r.humanAction === "do" && rate >= NEARLY_ALWAYS && avg >= SLOW_MS) {
      findings.push({
        ...base,
        kind: "worth_a_tool",
        observation: `Done on ${pct(rate)} of runs and takes about ${minutes(avg)} minutes each time.`,
        /* Deliberately not naming a product. "Buy a recorder" is a guess about
           their problem; "part of this looks mechanical" is an observation
           they can act on with what they already have. */
        suggestion:
          "This one is habitual and expensive. Worth asking which part of it is mechanical, and whether a tool could carry that part while the judgement stays with you.",
      });
      continue;
    }

    if (r.humanAction === "review" && rate >= NEARLY_ALWAYS && avg > 0 && avg < GLANCE_MS) {
      findings.push({
        ...base,
        kind: "pause_not_earning",
        observation: `Accepted on ${pct(rate)} of runs, in about ${Math.round(avg / 1000)} seconds.`,
        suggestion:
          "A review nobody spends time on is a habit rather than a check. Consider removing the pause and letting the chain run through, or keep it only where the step before it can be wrong in a way that matters.",
      });
      continue;
    }

    findings.push({
      ...base,
      kind: "healthy",
      observation: `Done on ${pct(rate)} of ${r.asked} runs${avg ? `, about ${minutes(avg)} minutes each` : ""}.`,
      suggestion: "Working as intended. Nothing to change.",
    });
  }

  const order: Record<HumanFindingKind, number> = {
    not_happening: 0,
    /* Above "worth a tool", because being late is usually the cheaper fix and
       the more surprising finding: nobody is expecting to be told that the
       problem with their preparation is when they do it. */
    left_late: 1,
    worth_a_tool: 2,
    pause_not_earning: 3,
    healthy: 4,
  };
  return findings.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.routineId.localeCompare(b.routineId) || a.stepIndex - b.stepIndex,
  );
}

/**
 * Read the rows for a person, from the store.
 *
 * Separated from readHumanSteps so the judgement stays testable without a
 * database. Never throws: an insight that fails is a missing paragraph, not a
 * broken page.
 */
export async function humanStepFindings(workspaceId: string): Promise<HumanFinding[]> {
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<{
      routine_id: string;
      step_index: number;
      label: string;
      human_action: string;
      asked: string;
      completed: string;
      skipped: string;
      avg_ms_when_done: string | null;
      fastest_ms_when_done: string | null;
    }>(
      `SELECT v.routine_id, v.step_index, v.label, v.human_action,
              v.asked, v.completed, v.skipped, v.avg_ms_when_done, v.fastest_ms_when_done
         FROM v_routine_human_steps v
         JOIN assistant_routine_runs r ON r.routine_id = v.routine_id
        WHERE r.workspace_id = $1
        GROUP BY v.routine_id, v.step_index, v.label, v.human_action,
                 v.asked, v.completed, v.skipped, v.avg_ms_when_done, v.fastest_ms_when_done
        LIMIT 500`,
      [workspaceId],
    );
    return readHumanSteps(
      rows.map((r) => ({
        routineId: r.routine_id,
        stepIndex: Number(r.step_index),
        label: r.label,
        humanAction: (r.human_action === "do" ? "do" : "review") as HumanAction,
        asked: Number(r.asked) || 0,
        completed: Number(r.completed) || 0,
        skipped: Number(r.skipped) || 0,
        avgMsWhenDone: r.avg_ms_when_done === null ? null : Number(r.avg_ms_when_done),
        fastestMs:
          r.fastest_ms_when_done === null ? null : Number(r.fastest_ms_when_done),
      })),
    );
  } catch {
    return [];
  }
}
