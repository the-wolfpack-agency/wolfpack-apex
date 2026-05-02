/**
 * Built-in validators wired to data Instinct already collects.
 * As Hoxsie + Nick write more principles, more validators get added
 * here.
 *
 * Real (production) evaluators:
 *   - calendar.focus_block_ratio          → calendar-focus-block.ts
 *   - calendar.meeting_outcome_logged     → calendar-meeting-outcome-logged.ts
 *   - calendar.recurring_meeting_drift    → calendar-recurring-meeting-drift.ts
 *   - mail.after_hours_send               → mail-after-hours.ts
 *   - tasks.overdue_rate                  → tasks-overdue.ts
 *   - tasks.weekly_priority_count         → tasks-weekly-priorities.ts
 *   - tasks.weekly_finish_rate            → tasks-weekly-finish-rate.ts
 *   - goals.kr_measurability              → goals-kr-measurability.ts
 *   - goals.kr_friday_status              → goals-kr-friday-status.ts
 *   - code.pr_cycle_time_under            → code-cycle-time.ts
 */

import {
  registerValidator,
  keywordMatcher,
} from "@/lib/principles/validators";
import { evaluateCalendarFocusBlock } from "@/lib/principles/evaluators/calendar-focus-block";
import { evaluateCalendarMeetingOutcomeLogged } from "@/lib/principles/evaluators/calendar-meeting-outcome-logged";
import { evaluateCalendarRecurringMeetingDrift } from "@/lib/principles/evaluators/calendar-recurring-meeting-drift";
import { evaluateMailAfterHours } from "@/lib/principles/evaluators/mail-after-hours";
import { evaluateTasksOverdue } from "@/lib/principles/evaluators/tasks-overdue";
import { evaluateTasksWeeklyPriorities } from "@/lib/principles/evaluators/tasks-weekly-priorities";
import { evaluateTasksWeeklyFinishRate } from "@/lib/principles/evaluators/tasks-weekly-finish-rate";
import { evaluateGoalsKrMeasurability } from "@/lib/principles/evaluators/goals-kr-measurability";
import { evaluateGoalsKrFridayStatus } from "@/lib/principles/evaluators/goals-kr-friday-status";
import { evaluateCodeCycleTime } from "@/lib/principles/evaluators/code-cycle-time";

registerValidator({
  id: "calendar.focus_block_ratio",
  surface: "calendar",
  describe: "Ratio of ≥2h non-meeting blocks during business hours",
  matches: (d) =>
    keywordMatcher("focus", "block")(d) || keywordMatcher("deep", "work")(d),
  evaluate: evaluateCalendarFocusBlock,
});

registerValidator({
  id: "calendar.meeting_outcome_logged",
  surface: "calendar",
  describe:
    "Past meetings have decisions / action items / next steps in the body",
  matches: (d) =>
    keywordMatcher("meeting", "outcome")(d) ||
    keywordMatcher("documented", "decisions")(d) ||
    keywordMatcher("decisions", "next", "steps")(d) ||
    keywordMatcher("meetings", "decisions")(d) ||
    keywordMatcher("meeting", "decisions")(d) ||
    keywordMatcher("closed", "out", "decisions")(d),
  evaluate: evaluateCalendarMeetingOutcomeLogged,
});

registerValidator({
  id: "calendar.recurring_meeting_drift",
  surface: "calendar",
  describe:
    "Recurring series carrying the same agenda items into a third week",
  matches: (d) =>
    keywordMatcher("recurring", "meeting")(d) ||
    keywordMatcher("recurring", "agenda")(d) ||
    keywordMatcher("recurring", "drift")(d) ||
    keywordMatcher("third", "week", "agenda")(d) ||
    keywordMatcher("recurring", "meetings", "carrying")(d),
  evaluate: evaluateCalendarRecurringMeetingDrift,
});

registerValidator({
  id: "mail.after_hours_send",
  surface: "mail",
  describe: "Outbound mail/Teams sent 9pm–7am local time",
  matches: (d) =>
    keywordMatcher("after", "hours")(d) ||
    keywordMatcher("off", "hours")(d) ||
    keywordMatcher("9pm")(d),
  evaluate: evaluateMailAfterHours,
});

registerValidator({
  id: "tasks.overdue_rate",
  surface: "tasks",
  describe: "Tasks past their due date",
  matches: (d) =>
    keywordMatcher("overdue")(d) ||
    keywordMatcher("past", "due")(d) ||
    keywordMatcher("task", "completion")(d),
  evaluate: evaluateTasksOverdue,
});

registerValidator({
  id: "tasks.weekly_priority_count",
  surface: "tasks",
  describe: "Active high-importance tasks per user per week (cap 3)",
  matches: (d) =>
    keywordMatcher("priority", "count")(d) ||
    keywordMatcher("priorities", "week")(d) ||
    keywordMatcher("priorities", "weekly")(d) ||
    keywordMatcher("fewer", "priorities")(d) ||
    keywordMatcher("high-importance", "active")(d) ||
    keywordMatcher("high", "importance", "tasks")(d) ||
    keywordMatcher("more", "than", "3", "high")(d) ||
    keywordMatcher("priority", "cap")(d) ||
    keywordMatcher("priorities", "per", "week")(d),
  evaluate: evaluateTasksWeeklyPriorities,
});

registerValidator({
  id: "tasks.weekly_finish_rate",
  surface: "tasks",
  describe: "Ratio of tasks created this window that completed by close",
  matches: (d) =>
    keywordMatcher("finish", "rate")(d) ||
    keywordMatcher("task", "finish")(d) ||
    keywordMatcher("tasks", "finish")(d) ||
    keywordMatcher("started", "finished")(d) ||
    keywordMatcher("weekly", "finish")(d),
  evaluate: evaluateTasksWeeklyFinishRate,
});

registerValidator({
  id: "goals.kr_measurability",
  surface: "goals",
  describe: "Every active OKR carries at least one numeric KR",
  matches: (d) =>
    keywordMatcher("measurable", "kr")(d) ||
    keywordMatcher("kr", "measurability")(d) ||
    keywordMatcher("goals", "measurable")(d),
  evaluate: evaluateGoalsKrMeasurability,
});

registerValidator({
  id: "goals.kr_friday_status",
  surface: "goals",
  describe: "Every active KR receives at least one contribution per week",
  matches: (d) =>
    keywordMatcher("kr", "friday")(d) ||
    keywordMatcher("kr", "status", "update")(d) ||
    keywordMatcher("kr", "at-risk")(d) ||
    keywordMatcher("kr", "at", "risk")(d) ||
    keywordMatcher("kr", "without", "status")(d) ||
    keywordMatcher("krs", "closed")(d) ||
    keywordMatcher("kr", "weekly", "update")(d),
  evaluate: evaluateGoalsKrFridayStatus,
});

registerValidator({
  id: "code.pr_cycle_time_under",
  surface: "code",
  describe: "PR cycle time open → merge < threshold hours",
  matches: (d) =>
    keywordMatcher("cycle", "time")(d) ||
    keywordMatcher("pr", "merge")(d) ||
    keywordMatcher("prs", "merged")(d) ||
    keywordMatcher("prs", "open")(d) ||
    keywordMatcher("prs", "sitting")(d),
  evaluate: evaluateCodeCycleTime,
});
