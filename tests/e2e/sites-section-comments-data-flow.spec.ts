/**
 * Sites — section comments data-flow E2E (Path C Phase 3 · Stream R3).
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID
 * like the other sites specs so CI is green on PRs that don't set them.
 *
 * Flow (real HTTP against the deployed URL when PROD_URL is set):
 *   1. Sign in as the designer; generate a share link via SharePanel.
 *   2. Open /share/<token> in a fresh incognito context.
 *   3. Stub the iframe postMessage to simulate a reviewer clicking a
 *      section — the iframe overlay would normally fire the comment.pin
 *      message. For the E2E we dispatch it directly into the parent
 *      page so we exercise the composer → POST round-trip without
 *      depending on overlay details that are deployment-dependent.
 *   4. Fill in the composer body + submit. Assert 200.
 *   5. Back on the authed designer view: the CommentsPane should
 *      render the newly-inserted comment after reload (proves the DB
 *      write actually landed, not just the HTTP response).
 *   6. Designer resolves the comment → state flips to "resolved".
 *   7. Reload the designer page — the resolved state persists (proves
 *      the UPDATE landed in the DB, not just local React state).
 */

import { test, expect, Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const projectId = process.env.SITES_SMOKE_PROJECT_ID;

test.describe("sites section comments data-flow", () => {
  test.skip(
    !target.email || !target.password || !projectId,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID not configured",
  );

  test("share-link reviewer comment → designer resolves → persists across reload", async ({
    page,
    browser,
  }) => {
    // ---- 1. Sign in + issue a share link ---------------------------
    const ok = await signInIfPossible(page, target);
    expect(ok).toBe(true);

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

    await page.goto(`${target.baseUrl}/sites/${projectId}`);
    const panel = page.getByTestId("share-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("generate-share-link").click();
    await expect(page.getByTestId("share-flash")).toBeVisible({
      timeout: 10_000,
    });
    expect(capturedToken).toBeTruthy();
    const token = capturedToken as unknown as string;

    // ---- 2. Open /share/<token> in incognito ------------------------
    const incognito = await browser.newContext();
    const clientPage: Page = await incognito.newPage();
    await clientPage.goto(`${target.baseUrl}/share/${token}`);
    await expect(clientPage.getByTestId("share-page-root")).toBeVisible({
      timeout: 15_000,
    });

    // ---- 3. Simulate the overlay firing comment.pin -----------------
    await clientPage.evaluate(() => {
      window.postMessage(
        {
          origin: "instinct.preview.v1",
          type: "comment.pin",
          pageIndex: 0,
          sectionIndex: 0,
          clientX: 200,
          clientY: 300,
        },
        window.location.origin,
      );
    });

    await expect(
      clientPage.getByTestId("share-comment-composer"),
    ).toBeVisible({ timeout: 5_000 });

    // ---- 4. Fill + submit -------------------------------------------
    const uniqueBody = `E2E section-comment ${Date.now()}`;
    await clientPage
      .getByTestId("share-comment-composer-body")
      .fill(uniqueBody);
    await clientPage.getByTestId("share-comment-composer-submit").click();
    await expect(
      clientPage.getByTestId("share-comment-composer-success"),
    ).toBeVisible({ timeout: 10_000 });
    await incognito.close();

    // ---- 5. Designer view shows the new comment ---------------------
    await page.reload();
    const pane = page.getByTestId("comments-pane");
    await expect(pane).toBeVisible({ timeout: 15_000 });
    // The body text appears somewhere inside the pane; a loose locator
    // tolerates the nested structure (group → card → body).
    await expect(pane.getByText(uniqueBody)).toBeVisible({
      timeout: 10_000,
    });

    // ---- 6. Designer resolves the comment ---------------------------
    // The comment card's testid is comment-<uuid>; we find the
    // resolve button under the matching card by navigating from the
    // body text.
    const card = pane.locator("div").filter({ hasText: uniqueBody }).first();
    await card.getByRole("button", { name: /resolve/i }).click();

    // ---- 7. Reload & verify persistence -----------------------------
    await page.reload();
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("comments-filter-resolved").click();
    await expect(pane.getByText(uniqueBody)).toBeVisible({
      timeout: 10_000,
    });
  });
});
