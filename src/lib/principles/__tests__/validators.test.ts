/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  registerValidator,
  listValidators,
  findValidatorForDescription,
  keywordMatcher,
  normalizeDesc,
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
      "mail.after_hours_send",
      "tasks.overdue_rate",
      "goals.kr_measurability",
      "code.pr_cycle_time_under",
    ]);

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
});
