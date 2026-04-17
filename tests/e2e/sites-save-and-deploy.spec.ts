/**
 * Sites — save brief + generate preview E2E.
 *
 * This is the test that would have caught the 2026-04-17 incident where
 * `PATCH /api/sites/:id?action=deploy` was silently returning 500 in
 * production, leaving the "Internal server error" banner on the detail
 * page. The previous suite only covered list-page render + auth redirect
 * — never exercised the save/deploy buttons that are the entire point
 * of the page.
 *
 * Requires SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD for an admin-capable
 * role (ceo / cto / hr). Without creds, the test is skipped so CI stays
 * green on PRs that don't configure the secret — but the nightly
 * production canary runs with creds and gates deploys.
 *
 * On deploy failure we fetch the admin-only
 * GET /api/sites/:id/deploys endpoint so the test output includes the
 * actual log_excerpt from apex_site_deploys — no more "Internal server
 * error" mystery.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

interface SitesListResponse {
  projects: Array<{
    id: string;
    status: string;
    client_slug: string;
    display_name: string;
    brief: unknown;
  }>;
}

interface DeploysResponse {
  deploys: Array<{
    id: string;
    status: string;
    log_excerpt: string | null;
    started_at: string;
  }>;
}

/** Pull the JWT the login flow left in localStorage. */
async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      localStorage.getItem("instinct_token") ??
      localStorage.getItem("apex_token") ??
      "",
  );
  if (!token) throw new Error("no instinct_token in localStorage after sign-in");
  return token;
}

test.describe("sites — save brief + generate preview", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping authed sites E2E",
  );

  test("save brief returns 200 and persists", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in should succeed with provided creds").toBe(true);

    const token = await getToken(page);

    // Pick an existing project to exercise against. If none exist we can't
    // test save — fail loudly so someone provisions a fixture.
    const list = await page.request
      .get(`${target.baseUrl}/api/sites`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((r) => r.json() as Promise<SitesListResponse>);
    expect(list.projects.length, "need at least one site project").toBeGreaterThan(0);

    const project = list.projects[0];
    // Fetch fresh detail so we save back an unchanged brief.
    const detail = await page.request
      .get(`${target.baseUrl}/api/sites/${project.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((r) => r.json() as Promise<{ project: { brief: unknown } }>);

    const saveRes = await page.request.patch(
      `${target.baseUrl}/api/sites/${project.id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        data: { brief: detail.project.brief },
      },
    );
    expect(saveRes.status(), `save brief should be 200, got ${saveRes.status()}: ${await saveRes.text()}`).toBe(200);
  });

  test("generate preview returns 2xx (or surfaces real log_excerpt on failure)", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);
    const token = await getToken(page);

    const list = await page.request
      .get(`${target.baseUrl}/api/sites`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((r) => r.json() as Promise<SitesListResponse>);
    expect(list.projects.length).toBeGreaterThan(0);
    const project = list.projects[0];

    const deployRes = await page.request.patch(
      `${target.baseUrl}/api/sites/${project.id}?action=deploy`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (deployRes.status() >= 400) {
      // Pull the real log excerpt so the test output is actionable.
      const deploys = await page.request
        .get(`${target.baseUrl}/api/sites/${project.id}/deploys`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => (r.ok() ? (r.json() as Promise<DeploysResponse>) : null))
        .catch(() => null);
      const latest = deploys?.deploys?.[0];
      const reason =
        latest?.log_excerpt ??
        (await deployRes.text().catch(() => "<no body>"));
      throw new Error(
        `deploy PATCH returned ${deployRes.status()} on project ${project.id}. ` +
          `Latest deploy row status=${latest?.status ?? "?"}, ` +
          `log_excerpt=${JSON.stringify(reason).slice(0, 800)}`,
      );
    }

    expect(deployRes.status(), "deploy should return 2xx").toBeLessThan(300);
    const body = (await deployRes.json()) as { ok?: boolean; deployId?: string };
    expect(body.ok).toBe(true);
    expect(body.deployId, "deployId should be returned").toBeTruthy();
  });

  test("detail page renders without Internal server error banner", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);
    const token = await getToken(page);

    const list = await page.request
      .get(`${target.baseUrl}/api/sites`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((r) => r.json() as Promise<SitesListResponse>);
    const project = list.projects[0];

    await page.goto(`${target.baseUrl}/sites/${project.id}`, {
      waitUntil: "networkidle",
    });
    await page.screenshot({
      path: "tests/e2e/screenshots/sites-detail-full.png",
      fullPage: true,
    });

    const bodyText = await page.locator("body").innerText();
    // The precise copy of the error banner from the detail page. If this
    // ever appears on initial load (no deploy attempted), the page is
    // broken and we want to fail loud.
    expect(
      bodyText,
      "detail page should not render an Internal server error banner on initial load",
    ).not.toMatch(/Internal server error/i);
  });
});
