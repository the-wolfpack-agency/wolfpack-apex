/**
 * platformDefaultBudgetUsd - the runaway backstop that bounds a workspace with
 * NO configured budget, so an unconfigured account is never uncapped.
 */
import { platformDefaultBudgetUsd } from "@/lib/ai/router";

it("defaults to a generous hard backstop when the env is unset", () => {
  expect(platformDefaultBudgetUsd({} as NodeJS.ProcessEnv)).toBe(25_000);
});

it("honors a numeric env override", () => {
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "500" } as unknown as NodeJS.ProcessEnv)).toBe(500);
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "0" } as unknown as NodeJS.ProcessEnv)).toBe(0);
});

it("returns null only when an operator explicitly opts out with a non-numeric/negative value", () => {
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "off" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  expect(platformDefaultBudgetUsd({ OGIAM_DEFAULT_MONTHLY_BUDGET_USD: "-1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
});
