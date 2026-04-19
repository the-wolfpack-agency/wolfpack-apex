/**
 * Sites — unauth share link + client approval E2E.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID
 * like the other sites specs so CI is green on PRs that don't set them.
 *
 * Flow (real HTTP against the deployed URL when PROD_URL is set,
 * otherwise localhost):
 *   1. Sign in as the designer.
 *   2. Navigate to /sites/[id] and mount SharePanel.
 *   3. Click "Generate share link" → capture the resulting token from
 *      the panel. We intercept the POST so the test works without the
 *      clipboard API being wired (headless browsers often lack it).
 *   4. Open /share/<token> in a fresh INCOGNITO context — proves there
 *      is no auth shell on the share page.
 *   5. Submit Approve + optional comment.
 *   6. Return to the designer page and assert the approval state chip
 *      reflects the new "Client approved" state.
 */

import { test, expect, Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const projectId = process.env.SITES_SMOKE_PROJECT_ID;

test.describe("sites share + approval flow", () => {
  test.skip(
    !target.email || !target.password || !projectId,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID not configured",
  );

  test("designer issues a share link → client approves → state reflects", async ({
    page,
    browser,
  }) => {
    // ---- 1. Sign in as designer ---------------------------------------
    const ok = await signInIfPossible(page, target);
    expect(ok).toBe(true);

    // Capture the token issued by POST so we can open the public page
    // without depending on the browser clipboard (headless often has
    // no write access).
    let capturedToken: string | null = null;
    await page.route("**/api/sites/*/share", async (route, req) => {
      if (req.method() === "POST") {
        const res = await route.fetch();
        const data = await res.json().catch(() => ({}));
        if (data?.token) capturedToken = data.token as string;
        return route.fulfill({ response: res });
      }
      return route.continue();
    });

    // ---- 2. Mount SharePanel on the detail page -----------------------
    await page.goto(`${target.baseUrl}/sites/${projectId}`);
    const panel = page.getByTestId("share-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // ---- 3. Generate a share link -------------------------------------
    const generateBtn = page.getByTestId("generate-share-link");
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();

    // Wait for the flash (indicates POST returned 200).
    await expect(page.getByTestId("share-flash")).toBeVisible({ timeout: 10_000 });
    expect(capturedToken).toBeTruthy();
    const token = capturedToken as unknown as string;

    // ---- 4. Open /share/<token> in a fresh incognito context -----------
    const incognito = await browser.newContext();
    const clientPage: Page = await incognito.newPage();
    await clientPage.goto(`${target.baseUrl}/share/${token}`);

    await expect(clientPage.getByTestId("share-page-root")).toBeVisible({ timeout: 15_000 });
    await expect(clientPage.getByTestId("share-banner")).toBeVisible();

    // ---- 5. Submit Approve + comment ----------------------------------
    await clientPage.getByTestId("share-comment").fill("Looks great — ship it.");
    await clientPage.getByTestId("share-actor-name").fill("Test Client");
    await clientPage.getByTestId("share-approve").click();

    await expect(clientPage.getByTestId("share-success")).toBeVisible({ timeout: 10_000 });
    await incognito.close();

    // ---- 6. Reload the designer page and verify the approval chip ------
    await page.reload();
    await expect(page.getByTestId("approval-state-chip")).toContainText(
      /Client approved/i,
      { timeout: 15_000 },
    );
  });
});
