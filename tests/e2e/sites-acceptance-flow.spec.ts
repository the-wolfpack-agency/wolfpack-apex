/**
 * Sites — acceptance criteria + verdict, driven through the real studio UI.
 *
 * This is the last place a defect in this feature can be caught before an
 * operator sees it, and the thing it has to prove is not that the form saves.
 * It is that the screen cannot mislead: a build whose check could not be
 * performed must never read as accepted, and an unchecked build must say so.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID,
 * skipped when any is missing so CI stays green on PRs that do not configure
 * them.
 *
 * Safety: every call to /api/sites/:id/acceptance is stubbed with page.route(),
 * so the test never writes a real project's contract and never queues a real
 * browser run. The states it needs (degraded, never-checked) are also states a
 * live backend cannot be asked to produce on demand.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const projectId = process.env.SITES_SMOKE_PROJECT_ID;

const CRITERIA = {
  prototypeUrl: "https://prototype.example.com/home.html",
  viewports: [{ width: 1512, height: 950 }],
  tolerancePx: 1.5,
  requiredRoutes: ["/", "/about"],
  requiredContent: ["Acme"],
  requireFontParity: true,
  maxLayoutDiffs: 0,
};

/** A run whose layout comparison never ran. Not a pass, and not a warning. */
const DEGRADED_RUN = {
  id: "run-degraded",
  deploy_id: "deploy-1",
  deployed_url: "https://build.example.com",
  status: "degraded",
  verdict: {
    accepted: false,
    summary: "Not accepted: layout could not be checked, so this is not a pass",
    checks: [
      { id: "routes", status: "passed", detail: "2 route(s) answered 2xx" },
      { id: "layout", status: "unmeasured", detail: "the comparison could not run: browser_unavailable" },
    ],
  },
  last_error: null,
  created_at: new Date().toISOString(),
};

test.describe("sites acceptance flow", () => {
  test.skip(
    !target.email || !target.password || !projectId,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID not configured",
  );

  test("an operator sets criteria and reads a verdict that never overstates itself", async ({ page }) => {
    let putBody: Record<string, unknown> | null = null;
    let runs: unknown[] = [];

    await page.route(`**/api/sites/${projectId}/acceptance**`, async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ configured: runs.length > 0, criteria: CRITERIA, completeness: 1, runs }),
        });
      }
      if (req.method() === "PUT") {
        putBody = JSON.parse(req.postData() ?? "{}");
        const sent = (putBody as { criteria?: Record<string, unknown> }).criteria ?? {};
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ criteria: { ...CRITERIA, ...sent }, completeness: 1 }),
        });
      }
      return route.continue();
    });

    const signedIn = await signInIfPossible(page, target);
    test.skip(!signedIn, "sign-in unavailable");

    await page.goto(`${target.baseUrl}/sites/${projectId}`, { waitUntil: "domcontentloaded" });

    // The tab has to be reachable from the studio rail, not just mounted.
    await page.getByTestId("studio-tab-dock-tab-acceptance").click();
    await expect(page.getByTestId("acceptance-panel")).toBeVisible({ timeout: 15_000 });

    // With no runs recorded, the screen must say the build is unverified rather
    // than showing an empty area that reads as "nothing wrong".
    await expect(page.getByTestId("acceptance-no-runs")).toContainText(/has not been checked/i);

    // The contract is a form: change a field and save it.
    await page.getByTestId("acceptance-routes").fill("/, /about, /contact");
    await page.getByTestId("acceptance-save").click();
    await expect(page.getByTestId("acceptance-saved")).toBeVisible({ timeout: 15_000 });
    expect(putBody).not.toBeNull();
    expect((putBody as unknown as { criteria: { requiredRoutes: string[] } }).criteria.requiredRoutes).toEqual([
      "/",
      "/about",
      "/contact",
    ]);

    // Now a run exists, and it is one whose layout check could not run. Reload
    // so the panel reads it the way it would after a real deploy.
    runs = [DEGRADED_RUN];
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("studio-tab-dock-tab-acceptance").click();

    const status = page.getByTestId("acceptance-latest-status");
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toHaveText("Could not be checked");
    // The assertion the whole layer exists for.
    await expect(status).not.toHaveText(/^Accepted$/);
    await expect(page.getByTestId("acceptance-check-layout")).toContainText("browser_unavailable");
    await expect(page.getByTestId("acceptance-latest-summary")).toContainText("not a pass");
  });

  test("a refused criterion names the field instead of failing vaguely", async ({ page }) => {
    await page.route(`**/api/sites/${projectId}/acceptance**`, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ configured: true, criteria: CRITERIA, completeness: 1, runs: [] }),
        });
      }
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "tolerancePx must be 0 to 50", field: "tolerancePx" }),
      });
    });

    const signedIn = await signInIfPossible(page, target);
    test.skip(!signedIn, "sign-in unavailable");

    await page.goto(`${target.baseUrl}/sites/${projectId}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("studio-tab-dock-tab-acceptance").click();
    await expect(page.getByTestId("acceptance-panel")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("acceptance-tolerance").fill("999");
    await page.getByTestId("acceptance-save").click();

    await expect(page.getByTestId("acceptance-error")).toContainText("tolerancePx", { timeout: 15_000 });
    await expect(page.getByTestId("acceptance-saved")).toHaveCount(0);
  });
});
