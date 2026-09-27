/**
 * attributeChecks: the before/after baseline discipline. A failing check is only
 * blamed on the change when it was PASSING on the baseline; a check failing on
 * both is pre-existing (not the change's fault); a failing check with no baseline
 * is indeterminate, never silently called clean.
 */
import { attributeChecks } from "@/lib/ai-code/ci-status";
import type { CheckRun } from "@/lib/github-client";

const pass = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success" });
const fail = (name: string): CheckRun => ({ name, status: "completed", conclusion: "failure" });
const pending = (name: string): CheckRun => ({ name, status: "in_progress", conclusion: null });

test("a check failing on the change but PASSING on baseline is INTRODUCED", () => {
  const a = attributeChecks([pass("build"), pass("unit")], [pass("unit"), fail("build")]);
  expect(a.introduced).toEqual(["build"]);
  expect(a.preexisting).toEqual([]);
  expect(a.clean).toBe(false);
  expect(a.reason).toMatch(/introduced 1 new failing/i);
});

test("a check failing on BOTH is PRE-EXISTING, not the change's fault", () => {
  const a = attributeChecks([fail("e2e"), pass("build")], [fail("e2e"), pass("build")]);
  expect(a.preexisting).toEqual(["e2e"]);
  expect(a.introduced).toEqual([]);
  expect(a.clean).toBe(true); // the change introduced nothing new
  expect(a.reason).toMatch(/introduced no new failures/i);
  expect(a.reason).toMatch(/already failing on the base/i);
});

test("a failing check with NO baseline entry is INDETERMINATE, never called clean-and-done", () => {
  const a = attributeChecks([pass("build")], [pass("build"), fail("new-check")]);
  expect(a.indeterminate).toEqual(["new-check"]);
  expect(a.introduced).toEqual([]);
  expect(a.reason).toMatch(/no baseline to compare/i);
});

test("a check failing on baseline but passing on the change is FIXED", () => {
  const a = attributeChecks([fail("lint")], [pass("lint")]);
  expect(a.fixed).toEqual(["lint"]);
  expect(a.introduced).toEqual([]);
});

test("no baseline at all -> baselineKnown false and an explicit could-not-attribute reason", () => {
  const a = attributeChecks([], [fail("build")]);
  expect(a.baselineKnown).toBe(false);
  expect(a.indeterminate).toEqual(["build"]);
  expect(a.reason).toMatch(/no baseline run was available/i);
});

test("baselineHealthy reflects whether the baseline had any failures", () => {
  expect(attributeChecks([pass("a"), pass("b")], [pass("a")]).baselineHealthy).toBe(true);
  expect(attributeChecks([pass("a"), fail("b")], [pass("a")]).baselineHealthy).toBe(false);
});

test("pending checks on the change are not attributed (nothing to conclude yet)", () => {
  const a = attributeChecks([pass("build")], [pending("build")]);
  expect(a.introduced).toEqual([]);
  expect(a.preexisting).toEqual([]);
  expect(a.indeterminate).toEqual([]);
});

test("mixed real-world case: one introduced, one pre-existing, one fixed", () => {
  const baseline = [pass("build"), fail("e2e"), fail("flaky")];
  const head = [fail("build"), fail("e2e"), pass("flaky")];
  const a = attributeChecks(baseline, head);
  expect(a.introduced).toEqual(["build"]); // was green, now red -> the change
  expect(a.preexisting).toEqual(["e2e"]); // red before and after -> not the change
  expect(a.fixed).toEqual(["flaky"]); // was red, now green -> the change fixed it
  expect(a.clean).toBe(false);
});
