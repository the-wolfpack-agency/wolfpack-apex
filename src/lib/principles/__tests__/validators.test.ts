/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  registerValidator,
  listValidators,
  findValidatorForDescription,
  keywordMatcher,
  normalizeDesc,
  snapToUtcDay,
  _resetRegistryForTests,
  type Validator,
} from "@/lib/principles/validators";

beforeEach(() => {
  _resetRegistryForTests();
});

describe("normalizeDesc", () => {
  test("lowercases + collapses whitespace + drops punctuation", () => {
    expect(normalizeDesc("  PR cycle time, < 48h!  ")).toBe(
      "pr cycle time < 48h",
    );
  });
});

describe("keywordMatcher", () => {
  test("requires every keyword (case-insensitive)", () => {
    const m = keywordMatcher("focus", "block");
    expect(m("Focus block ratio")).toBe(true);
    expect(m("blocky focus zone")).toBe(true);
    expect(m("focus only")).toBe(false);
    expect(m("just blocks")).toBe(false);
  });
  test("punctuation in description doesn't block matches", () => {
    expect(keywordMatcher("after", "hours")("After-hours sends!")).toBe(true);
  });
});

describe("registry", () => {
  test("registerValidator + listValidators round-trip", () => {
    const v: Validator = {
      id: "test.one",
      surface: "code",
      describe: "test validator",
      matches: () => true,
      evaluate: async () => [],
    };
    registerValidator(v);
    expect(listValidators().map((x) => x.id)).toEqual(["test.one"]);
  });

  test("registering a duplicate id throws (prevents silent override)", () => {
    const v: Validator = {
      id: "test.dup",
      surface: "code",
      describe: "x",
      matches: () => true,
      evaluate: async () => [],
    };
    registerValidator(v);
    expect(() => registerValidator(v)).toThrow(/already registered/);
  });

  test("findValidatorForDescription returns the first match", () => {
    registerValidator({
      id: "calendar.focus_block_ratio",
      surface: "calendar",
      describe: "focus blocks",
      matches: keywordMatcher("focus", "block"),
      evaluate: async () => [],
    });
    registerValidator({
      id: "mail.after_hours_send",
      surface: "mail",
      describe: "after hours",
      matches: keywordMatcher("after", "hours"),
      evaluate: async () => [],
    });
    expect(findValidatorForDescription("Focus block ratio ≥ 0.4")?.id).toBe(
      "calendar.focus_block_ratio",
    );
    expect(findValidatorForDescription("After-hours sends")?.id).toBe(
      "mail.after_hours_send",
    );
    expect(findValidatorForDescription("nothing relevant")).toBeNull();
  });
});

describe("built-in validators", () => {
  test("each starter validator matches its expected description", () => {
    /* Importing built-in-validators registers the 5 starters as a
       side effect. Reset first to avoid cross-test pollution. */
    _resetRegistryForTests();
    require("@/lib/principles/built-in-validators");
    const ids = listValidators().map((v) => v.id);
    expect(ids).toEqual([
      "calendar.focus_block_ratio",
      "calendar.meeting_outcome_logged",
      "calendar.meeting_density",
      "calendar.meeting_agenda_present",
      "calendar.declined_attendance_rate",
      "calendar.recurring_meeting_drift",
      "mail.after_hours_send",
      "tasks.overdue_rate",
      "tasks.weekly_priority_count",
      "tasks.weekly_finish_rate",
      "goals.kr_measurability",
      "goals.kr_friday_status",
      "code.pr_cycle_time_under",
    ]);

    /* Each new validator binds the wording in the SharePoint principles
       doc — these assertions are the safety net for the keyword
       matchers, so a typo in the doc never silently de-registers a
       signal again. */
    expect(
      findValidatorForDescription(
        "more than 3 high-importance active tasks in the same week",
      )?.id,
    ).toBe("tasks.weekly_priority_count");
    expect(
      findValidatorForDescription("weekly task finish rate above 70 percent")
        ?.id,
    ).toBe("tasks.weekly_finish_rate");
    expect(
      findValidatorForDescription("KRs without status update by Friday")?.id,
    ).toBe("goals.kr_friday_status");
    expect(
      findValidatorForDescription(
        "meetings closed out with documented decisions and next steps",
      )?.id,
    ).toBe("calendar.meeting_outcome_logged");
    expect(
      findValidatorForDescription(
        "recurring meetings carrying the same agenda items into a third week",
      )?.id,
    ).toBe("calendar.recurring_meeting_drift");
    expect(
      findValidatorForDescription("PRs sitting open more than 5 days without merge")
        ?.id,
    ).toBe("code.pr_cycle_time_under");
    expect(
      findValidatorForDescription("ten or fewer meetings per week")?.id,
    ).toBe("calendar.meeting_density");
    expect(
      findValidatorForDescription("every meeting has a written agenda")?.id,
    ).toBe("calendar.meeting_agenda_present");
    expect(
      findValidatorForDescription("calendar reflects reality — no ghost meetings")
        ?.id,
    ).toBe("calendar.declined_attendance_rate");

    expect(
      findValidatorForDescription("Focus block ratio ≥ 0.4")?.id,
    ).toBe("calendar.focus_block_ratio");
    expect(
      findValidatorForDescription("Outbound mail sent after-hours")?.id,
    ).toBe("mail.after_hours_send");
    expect(
      findValidatorForDescription("Overdue task rate < 5%")?.id,
    ).toBe("tasks.overdue_rate");
    expect(
      findValidatorForDescription("Every active goal carries a measurable KR")
        ?.id,
    ).toBe("goals.kr_measurability");
    expect(
      findValidatorForDescription("PR cycle time < 48h")?.id,
    ).toBe("code.pr_cycle_time_under");
  });

  test("team-wide flag is set on the right validators", () => {
    /* Run inside isolateModules so the validators module + the side-
       effect importer share the same fresh registry. The previous
       test left the cached validators module's registry already
       populated; without isolation both _resetRegistryForTests +
       require would target different module instances. */
    jest.isolateModules(() => {
      const validatorsModule: typeof import("@/lib/principles/validators") = require("@/lib/principles/validators");
      validatorsModule._resetRegistryForTests();
      require("@/lib/principles/built-in-validators");
      const ids = validatorsModule
        .listValidators()
        .filter((v) => v.teamWide)
        .map((v) => v.id)
        .sort();
      expect(ids).toEqual([
        "code.pr_cycle_time_under",
        "goals.kr_friday_status",
        "goals.kr_measurability",
      ]);
    });
  });
});

describe("snapToUtcDay", () => {
  test("snaps mid-day timestamps to 00:00:00.000Z of the same UTC date", () => {
    expect(snapToUtcDay("2026-05-02T08:43:25.123Z")).toBe(
      "2026-05-02T00:00:00.000Z",
    );
    expect(snapToUtcDay("2026-05-02T08:43:10Z")).toBe(
      "2026-05-02T00:00:00.000Z",
    );
  });
  test("two timestamps within the same UTC day collapse to identical key", () => {
    /* The whole point of the helper: a 15-second drift between cron
       runs (the bug we shipped migration 122 to fix) must produce the
       same observed_at — otherwise the unique index can't dedupe. */
    expect(snapToUtcDay("2026-04-30T06:43:25Z")).toBe(
      snapToUtcDay("2026-04-30T06:43:10Z"),
    );
  });
  test("unparseable input is returned unchanged (defensive — never crashes)", () => {
    expect(snapToUtcDay("not-a-timestamp")).toBe("not-a-timestamp");
  });
});
