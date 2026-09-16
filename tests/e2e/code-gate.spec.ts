/**
 * Code gate, end to end through the real browser, against the deployed app.
 * Wired into deployment-journey.yml so it runs on every deploy with the shared
 * ADMIN_E2E_* secret - it is NOT a dormant skip. It proves the thing a person
 * actually loads works: paste a diff that logs a reset link, and the page shows
 * the gate blocking it. Skips loudly (never a silent pass) when creds are unset.
 */
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/assistant";

const URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.JOURNEY_EMAIL ?? process.env.ADMIN_E2E_EMAIL;
const PASSWORD = process.env.JOURNEY_PASSWORD ?? process.env.ADMIN_E2E_PASSWORD;

test.describe("code gate (post-deploy, real browser)", () => {
  test.skip(!URL || !EMAIL || !PASSWORD, "set PROD_URL + ADMIN_E2E_EMAIL/PASSWORD (deployment-journey supplies these)");

  test("blocks a diff that logs a reset link, in the browser", async ({ page }) => {
    await signIn(page, URL!, EMAIL!, PASSWORD!);
    await page.goto(`${URL}/admin/ai-code`, { waitUntil: "domcontentloaded" });
    await page
      .getByLabel("Unified diff")
      .fill("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,1 @@\n+console.log(`reset link: ${resetUrl}`);");
    await page.getByRole("button", { name: /review/i }).click();
    await expect(page.getByText(/Blocked - do not merge/)).toBeVisible({ timeout: 30_000 });
  });
});
