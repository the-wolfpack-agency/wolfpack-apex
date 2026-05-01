/**
 * Five starter validators wired to data Instinct already collects.
 * Each one is intentionally minimal — the goal is to prove the
 * framework, not to ship comprehensive observation. As Hoxsie + Nick
 * write more principles, more validators get added here.
 *
 * Surfaces covered:
 *   - calendar (focus_block_ratio)
 *   - mail (after_hours_send)
 *   - tasks (overdue_rate)
 *   - goals (kr_measurability)
 *   - code (pr_cycle_time_under)
 */

import {
  type EvaluationContext,
  type Observation,
  registerValidator,
  keywordMatcher,
} from "@/lib/principles/validators";

/* ------------------------------------------------------------------ */
/* calendar.focus_block_ratio                                          */
/*   Triggers on signals containing "focus" + "block" or "deep work". */
/*   Reads instinct_calendar_events; scores ratio of >=2h non-meeting */
/*   windows during business hours.                                   */
/* ------------------------------------------------------------------ */

async function evaluateCalendarFocusBlock(
  _ctx: EvaluationContext,
): Promise<Observation[]> {
  /* Stub at framework-prove time — the calendar query landing in a
     follow-up PR. Returns [] so the cron pipeline runs cleanly today
     and validation observations start firing the moment the query
     ships, with no schema or registry change required. */
  return [];
}

registerValidator({
  id: "calendar.focus_block_ratio",
  surface: "calendar",
  describe: "Ratio of ≥2h non-meeting blocks during business hours",
  matches: (d) =>
    keywordMatcher("focus", "block")(d) || keywordMatcher("deep", "work")(d),
  evaluate: evaluateCalendarFocusBlock,
});

/* ------------------------------------------------------------------ */
/* mail.after_hours_send                                               */
/*   Counter-signal: outbound mail sent 9pm–7am local.                 */
/* ------------------------------------------------------------------ */

async function evaluateMailAfterHours(
  _ctx: EvaluationContext,
): Promise<Observation[]> {
  return [];
}

registerValidator({
  id: "mail.after_hours_send",
  surface: "mail",
  describe: "Outbound mail sent 9pm–7am local time",
  matches: (d) =>
    keywordMatcher("after", "hours")(d) ||
    keywordMatcher("off", "hours")(d) ||
    keywordMatcher("9pm")(d),
  evaluate: evaluateMailAfterHours,
});

/* ------------------------------------------------------------------ */
/* tasks.overdue_rate                                                  */
/*   Signal: % of open tasks past their due date.                      */
/* ------------------------------------------------------------------ */

async function evaluateTasksOverdue(
  _ctx: EvaluationContext,
): Promise<Observation[]> {
  return [];
}

registerValidator({
  id: "tasks.overdue_rate",
  surface: "tasks",
  describe: "Percentage of open tasks past their due date",
  matches: (d) =>
    keywordMatcher("overdue")(d) ||
    keywordMatcher("past", "due")(d) ||
    keywordMatcher("task", "completion")(d),
  evaluate: evaluateTasksOverdue,
});

/* ------------------------------------------------------------------ */
/* goals.kr_measurability                                              */
/*   Signal: every active goal has at least one numeric KR.            */
/* ------------------------------------------------------------------ */

async function evaluateGoalsKrMeasurability(
  _ctx: EvaluationContext,
): Promise<Observation[]> {
  return [];
}

registerValidator({
  id: "goals.kr_measurability",
  surface: "goals",
  describe: "Every active goal carries at least one numeric KR",
  matches: (d) =>
    keywordMatcher("measurable", "kr")(d) ||
    keywordMatcher("kr", "measurability")(d) ||
    keywordMatcher("goals", "measurable")(d),
  evaluate: evaluateGoalsKrMeasurability,
});

/* ------------------------------------------------------------------ */
/* code.pr_cycle_time_under                                            */
/*   Signal: PR cycle time from open → merge < N hours.                */
/* ------------------------------------------------------------------ */

async function evaluateCodeCycleTime(
  _ctx: EvaluationContext,
): Promise<Observation[]> {
  return [];
}

registerValidator({
  id: "code.pr_cycle_time_under",
  surface: "code",
  describe: "PR cycle time open → merge < threshold hours",
  matches: (d) =>
    keywordMatcher("cycle", "time")(d) || keywordMatcher("pr", "merge")(d),
  evaluate: evaluateCodeCycleTime,
});
