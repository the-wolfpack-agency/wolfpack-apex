/**
 * /knowledge — semantic Q&A cache + LLM fallback.
 *
 * What this spec proves end-to-end (real browser):
 *
 *   1. First time a question is asked, /api/knowledge/ask returns
 *      was_cache_hit=false. The AI badge is visible (source =
 *      ai_generated).
 *   2. Asking the SAME question a second time returns was_cache_hit=true.
 *      The AI badge is STILL visible — the answer is still AI-sourced,
 *      we just served it from the cache. No LLM call is observable.
 *   3. Clicking "Helpful" hits /api/knowledge/feedback successfully.
 *
 * Migration 108 + src/lib/knowledge/qa-cache.ts +
 * /api/knowledge/{ask,feedback}.
 *
 * Soft gate while we wait for OPENAI_API_KEY to be wired in CI: this
 * spec runs continue-on-error. Promote to a hard gate once the embed
 * key + DB are reliably available against the smoke target.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("/knowledge semantic Q&A cache", () => {
  test.beforeEach(async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(
        true,
        "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping",
      );
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);
  });

  test("ask twice → first miss + AI badge, second is a cache hit", async ({
    page,
  }) => {
    const response = await page.goto(`${target.baseUrl}/knowledge`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status() ?? 0).toBeLessThan(400);

    /* Open the Ask panel. */
    await page.getByRole("button", { name: /ask a question/i }).click();

    /* Use a question that almost certainly is not seeded so we hit
       the LLM path on first ask. The cache is keyed on normalized
       question + surface, so the second ask must collide. */
    const uniqueQuestion = `qa-cache-e2e how do I rotate my JWT refresh token in instinct ${Date.now()}`;

    /* First ask — capture the response so we can assert was_cache_hit
       directly, not just "the badge is there". */
    const firstAskPromise = page.waitForResponse((r) =>
      r.url().includes("/api/knowledge/ask") && r.request().method() === "POST",
    );
    await page
      .getByPlaceholder(/what would you like to know/i)
      .fill(uniqueQuestion);
    /* exact: getByRole matches the accessible name by SUBSTRING, so "Ask"
   also matched the "Ask a Question" button that opens this panel, and
   the click hit two elements. */
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    const firstResp = await firstAskPromise;
    const firstBody = await firstResp.json();
    expect(firstBody.was_cache_hit).toBe(false);
    await expect(page.getByTestId("knowledge-ai-badge")).toBeVisible();

    /* Mark Helpful → the feedback endpoint must accept the click. */
    const fbPromise = page.waitForResponse((r) =>
      r.url().includes("/api/knowledge/feedback"),
    );
    await page.getByTestId("knowledge-feedback-helpful").click();
    const fbResp = await fbPromise;
    expect(fbResp.status()).toBe(200);

    /* Second ask, same wording. The exact-match fast path should hit. */
    const secondAskPromise = page.waitForResponse((r) =>
      r.url().includes("/api/knowledge/ask") && r.request().method() === "POST",
    );
    /* Re-open the Ask panel (the click on Helpful does not close it,
       but the input may still hold the previous value). */
    await page
      .getByPlaceholder(/what would you like to know/i)
      .fill(uniqueQuestion);
    /* exact: getByRole matches the accessible name by SUBSTRING, so "Ask"
   also matched the "Ask a Question" button that opens this panel, and
   the click hit two elements. */
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    const secondResp = await secondAskPromise;
    const secondBody = await secondResp.json();
    expect(secondBody.was_cache_hit).toBe(true);
    /* The AI badge must STILL be present — the answer is still
       AI-sourced, we just served it from the cache. */
    await expect(page.getByTestId("knowledge-ai-badge")).toBeVisible();
    /* The cache badge confirms the hit visually. */
    await expect(page.getByTestId("knowledge-cache-badge")).toBeVisible();
  });
});
