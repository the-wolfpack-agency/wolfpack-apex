/**
 * platformDefaultBudgetUsd - the runaway backstop that bounds a workspace with
 * NO configured budget, so an unconfigured account is never uncapped.
 */
import {
  platformDefaultBudgetUsd,
  unattributedBudgetUsd,
  PLATFORM_DEFAULT_MONTHLY_BUDGET_USD,
} from "@/lib/ai/router";
import { CEILING_MULTIPLE, WARN_FRACTION } from "@/lib/ai/budget";

/* The heaviest month this deployment has recorded, measured 2026-10-24 (see the
   comment on platformDefaultBudgetUsd). Pinned here so the default cannot be
   lowered under it without this test saying why that is a problem. */
const HIGHEST_MEASURED_MONTH_USD = 263.76;

it("defaults to a backstop sized from measured spend when the env is unset", () => {
  expect(platformDefaultBudgetUsd({} as NodeJS.ProcessEnv)).toBe(1_000);
  expect(PLATFORM_DEFAULT_MONTHLY_BUDGET_USD).toBe(1_000);
});

it("never throttles legitimate peak use: at least 3x the heaviest measured month, with the warn line above it too", () => {
  expect(PLATFORM_DEFAULT_MONTHLY_BUDGET_USD).toBeGreaterThanOrEqual(3 * HIGHEST_MEASURED_MONTH_USD);
  /* The first thing the governor does is clamp at WARN_FRACTION of the cap.
     That line, not the cap, is where dogfooding would first notice. */
  expect(PLATFORM_DEFAULT_MONTHLY_BUDGET_USD * WARN_FRACTION).toBeGreaterThan(3 * HIGHEST_MEASURED_MONTH_USD);
});

it("is a real control, not a number chosen never to fire: far below the old $25,000", () => {
  expect(PLATFORM_DEFAULT_MONTHLY_BUDGET_USD * CEILING_MULTIPLE).toBeLessThan(25_000);
});

it("bounds the unattributed bucket by the platform default unless separately overridden", () => {
  expect(unattributedBudgetUsd({} as NodeJS.ProcessEnv)).toBe(1_000);
  expect(unattributedBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "400" } as unknown as NodeJS.ProcessEnv)).toBe(400);
  expect(
    unattributedBudgetUsd({
      OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "400",
      OGIAM_UNATTRIBUTED_MONTHLY_BUDGET_USD: "50",
    } as unknown as NodeJS.ProcessEnv),
  ).toBe(50);
  expect(unattributedBudgetUsd({ OGIAM_UNATTRIBUTED_MONTHLY_BUDGET_USD: "off" } as unknown as NodeJS.ProcessEnv)).toBeNull();
});

it("honors a numeric env override", () => {
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "500" } as unknown as NodeJS.ProcessEnv)).toBe(500);
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "0" } as unknown as NodeJS.ProcessEnv)).toBe(0);
});

it("returns null only when an operator explicitly opts out with a non-numeric/negative value", () => {
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "off" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "-1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
});
