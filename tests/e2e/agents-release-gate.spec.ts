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

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

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

test("dispatch an agent to triage a blocking deploy from the gate", async ({ page }) => {
  await stubInstinctSession(page, { role: "admin" });

  await page.route(/\/api\/admin\/agents(\?|$)/, (route: Route) =>
    route.fulfill(
      json({
        agents: [
          { id: "a1", name: "Aria", role: "ops", state: "active", ownerUserId: "u", workspaceId: "default", identityProvider: "local", externalSubject: null, scanStatus: "complete", description: null, createdBy: "u", createdAt: "2026-07-01T00:00:00Z", activatedAt: null, lastSeenAt: null, revokedAt: null, connections: [] },
        ],
      }),
    ),
  );
  await page.route("**/api/admin/deployment/release-gate", (route: Route) =>
    route.fulfill(
      json({
        ok: true,
        gate: {
          productionBranch: "main",
          checkedAt: "2026-07-10T00:00:00Z",
          blocking: [{ number: 42, title: "Fix the thing", url: "https://gh/42", author: "n", state: "checks_failing", reason: "a check is failing", ageHours: 3 }],
        },
      }),
    ),
  );
  // The task-assign path returns a terminal triage task.
  await page.route(/\/api\/admin\/agents\/a1\/tasks$/, (route: Route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    // The panel composed a read-only triage task tagged with its source.
    expect(body.source).toBe("deploy_gate");
    expect(body.objective).toContain("Triage PR #42");
    return route.fulfill(json({ task: { id: "t1", status: "succeeded", resultSummary: "Assessed: needs a rebase." } }, 201));
  });

  await page.goto(`${target.baseUrl}/admin/agents`, { waitUntil: "domcontentloaded", timeout: 20_000 });

  await page.getByTestId("triage-open-42").click({ timeout: 15_000 });
  await expect(page.getByTestId("triage-agent-42")).toBeVisible();
  await page.getByTestId("triage-dispatch-42").click();
  await expect(page.getByTestId("triage-result-42")).toContainText("succeeded", { timeout: 15_000 });
});
