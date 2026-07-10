/**
 * Deployment control plane, step 1: the Production Release Gate is surfaced on
 * the agents page. Drives the real page bundle with a stubbed session and an
 * intercepted gate route, and asserts a blocking PR renders in the panel.
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test("the release gate is surfaced on the agents page with its blocking PRs", async ({ page }) => {
  const snapshot = collectConsoleAndNetworkFailures(page);
  await stubInstinctSession(page, { role: "admin" });

  await page.route(/\/api\/admin\/agents(\?|$)/, (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: [] }) }),
  );
  await page.route("**/api/admin/deployment/release-gate", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        gate: {
          productionBranch: "main",
          checkedAt: "2026-07-10T00:00:00Z",
          blocking: [
            { number: 42, title: "Fix the thing", url: "https://gh/42", author: "nhomyk", state: "checks_failing", reason: "checks failing", ageHours: 3 },
          ],
        },
      }),
    }),
  );

  await page.goto(`${target.baseUrl}/admin/agents`, { waitUntil: "domcontentloaded", timeout: 20_000 });

  const panel = page.getByTestId("agents-release-gate");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const pr = page.getByTestId("agents-release-gate-pr-42");
  await expect(pr).toContainText("Fix the thing");
  await expect(pr).toContainText("Checks failing");
  await expect(page.getByTestId("agents-release-gate-open-full")).toHaveAttribute("href", "/admin/deployment");

  const consoleFailures = snapshot().filter((f) => f.kind === "console");
  expect(consoleFailures, JSON.stringify(consoleFailures, null, 2)).toEqual([]);
});
