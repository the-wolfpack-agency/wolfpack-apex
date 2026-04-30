/**
 * /admin/assistant-debug — E2E reality check.
 *
 * Signs in as the smoke account, navigates to the debug page, and
 * asserts:
 *   - the page renders 200 (not a blank 401 error page)
 *   - all five diagnostic sections are present
 *   - the default question is pre-filled
 *   - the diagnosis paragraph appears
 *
 * Skips when SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD are missing so
 * canary runs without creds don't fail red.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("assistant grounding diagnostic page", () => {
  test("renders all sections after sign-in", async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set");
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);

    const resp = await page.goto(`${target.baseUrl}/admin/assistant-debug`, {
      waitUntil: "networkidle",
    });
    expect(resp?.status() ?? 0).toBeLessThan(400);

    await expect(page.getByTestId("assistant-debug-page")).toBeVisible({
      timeout: 15_000,
    });

    /* Eventually the API call resolves and all five sections mount.
       We poll because /api/assistant/grounding-debug runs ~6 live
       Graph probes and may take a couple seconds in the worst case. */
    await expect
      .poll(
        async () => {
          const ids = [
            "section-user",
            "section-token",
            "section-probes",
            "section-bundle",
            "section-diagnosis",
          ];
          for (const id of ids) {
            if ((await page.getByTestId(id).count()) === 0) return id;
          }
          return null;
        },
        { timeout: 30_000 },
      )
      .toBeNull();

    /* Custom-question input should default to the recurring failing
       test case so the user sees the diagnosis with zero typing. */
    const input = page.getByTestId("assistant-debug-question-input");
    await expect(input).toHaveValue(/TWA Agenda 4\.20/);

    /* Diagnosis paragraph is non-empty. */
    const diag = page.getByTestId("diagnosis-text");
    await expect(diag).toBeVisible();
    const text = (await diag.textContent()) || "";
    expect(text.trim().length).toBeGreaterThan(20);
  });

  test("redirects to /login when not signed in", async ({ page }) => {
    /* Fresh context — no auth. Dashboard layout should redirect to
       /login. We don't hard-require this in production-no-auth runs;
       skip when the deployed URL might host a non-redirecting variant. */
    if (target.isProduction && (!target.email || !target.password)) {
      test.skip(true, "Skipping anonymous nav check on prod without creds");
      return;
    }
    await page.context().clearCookies();
    await page.evaluate(() => {
      try {
        window.localStorage.clear();
      } catch {}
    });
    await page.goto(`${target.baseUrl}/admin/assistant-debug`, {
      waitUntil: "domcontentloaded",
    });
    /* The dashboard layout redirects unauthenticated users to /login.
       Allow either the redirected URL OR the loading state followed
       by a redirect within 5s (some browsers race the JS push). */
    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), {
        timeout: 10_000,
      })
      .catch(() => null);
    expect(page.url()).toMatch(/\/login/);
  });
});
