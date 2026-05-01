/**
 * Five starter validators wired to data Instinct already collects.
 * As Hoxsie + Nick write more principles, more validators get added
 * here.
 *
 * Real (production) evaluators:
 *   - calendar.focus_block_ratio  → calendar-focus-block.ts
 *   - mail.after_hours_send       → mail-after-hours.ts
 *   - tasks.overdue_rate          → tasks-overdue.ts
 *   - goals.kr_measurability      → goals-kr-measurability.ts
 *   - code.pr_cycle_time_under    → code-cycle-time.ts
 */

import {
  registerValidator,
  keywordMatcher,
} from "@/lib/principles/validators";
import { evaluateCalendarFocusBlock } from "@/lib/principles/evaluators/calendar-focus-block";
import { evaluateMailAfterHours } from "@/lib/principles/evaluators/mail-after-hours";
import { evaluateTasksOverdue } from "@/lib/principles/evaluators/tasks-overdue";
import { evaluateGoalsKrMeasurability } from "@/lib/principles/evaluators/goals-kr-measurability";
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
  id: "mail.after_hours_send",
  surface: "mail",
  describe: "Outbound mail sent 9pm–7am local time",
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
  id: "code.pr_cycle_time_under",
  surface: "code",
  describe: "PR cycle time open → merge < threshold hours",
  matches: (d) =>
    keywordMatcher("cycle", "time")(d) || keywordMatcher("pr", "merge")(d),
  evaluate: evaluateCodeCycleTime,
});
