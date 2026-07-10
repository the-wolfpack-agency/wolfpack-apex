/**
 * Deployment pipeline E2E — the fleet pipeline panel on /admin/deployment,
 * including the deploy -> agent-regression correlation line on the live deploy.
 *
 * Drives the real page bundle with a stubbed session and intercepted deployment
 * APIs, so it is deterministic and non-destructive. Asserts the pipeline panel
 * renders each change's stitched stepper, and that the live deploy surfaces the
 * agent model regressions flagged since it went live (the cross-data insight).
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const SIX_GREEN = [
  { key: "ci", label: "CI checks", status: "passed", detail: "Checks passed before merge" },
  { key: "merge", label: "Merge", status: "passed", detail: "Merged to the production branch" },
  { key: "build", label: "Build + migrate", status: "passed", detail: "Built" },
  { key: "promote", label: "Promote", status: "passed", detail: "Promoted to production" },
  { key: "verify", label: "Prod verify", status: "passed", detail: "Live: the production alias serves this commit" },
  { key: "health", label: "Health", status: "passed", detail: "Production health checks pass" },
];

const LIVE_WITH_IMPACT = {
  id: "sha1",
  title: "feat: bump the model",
  url: "https://vercel.com",
  author: "nhomyk",
  commitSha: "sha1",
  prNumber: null,
  ageHours: null,
  hasMigration: false,
  live: true,
  status: "deployed",
  currentStage: "health",
  stages: SIX_GREEN,
  agentImpact: {
    regressionCount: 2,
    since: "2026-07-10T00:00:00Z",
    regressions: [
      { agentId: "agt-a", baselineModel: "gpt-old", candidateModel: "gpt-new", delta: -0.4 },
      { agentId: "agt-b", baselineModel: "gpt-old", candidateModel: "gpt-new", delta: -0.2 },
    ],
  },
};

async function stubApis(page: import("@playwright/test").Page) {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/admin/deployment-readiness", (r: Route) =>
    r.fulfill(json({ ok: true, checks: [{ name: "DATABASE_URL", pass: true, detail: "set", critical: true }] })),
  );
  await page.route("**/api/admin/deployment/release-gate", (r: Route) =>
    r.fulfill(json({ ok: true, gate: { productionBranch: "main", blocking: [], checkedAt: "2026-07-10T00:00:00Z" }, plan: null })),
  );
  await page.route("**/api/admin/deployment/pipeline", (r: Route) =>
    r.fulfill(json({ ok: true, pipelines: [LIVE_WITH_IMPACT], servingSha: "sha1", checkedAt: "t", degraded: [] })),
  );
}

test.describe("Deployment pipeline — fleet view", () => {
  test("unauthenticated visit redirects to /login (never blank)", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/deployment`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 }).catch(() => null);
    expect(page.url()).toContain("/login");
  });

  test("authenticated: the pipeline panel renders and the live deploy shows agent-regression impact", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    await stubInstinctSession(page, { role: "cto" });
    await stubApis(page);

    await page.goto(`${target.baseUrl}/admin/deployment`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    const panel = page.getByTestId("deployment-pipeline");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId("deployment-pipeline-row-sha1");
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("deployment-pipeline-row-sha1-stepper-step-health")).toBeVisible();

    // The cross-data insight: agent regressions flagged since this deploy went live.
    const impact = page.getByTestId("deployment-pipeline-row-sha1-impact");
    await expect(impact).toBeVisible();
    await expect(impact).toContainText(/2 agent model regressions flagged since this went live/i);
    await expect(impact).toContainText("gpt-old → gpt-new");

    const consoleFailures = snapshot().filter((f) => f.kind === "console");
    expect(consoleFailures, `console/CSP failures: ${JSON.stringify(consoleFailures, null, 2)}`).toEqual([]);
  });
});
