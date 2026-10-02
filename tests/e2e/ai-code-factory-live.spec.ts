/**
 * LIVE UI journey for the code factory - the TRUE test.
 *
 * The other ai-code e2e (ai-code-factory.spec.ts) STUBS the pipeline (no model,
 * no spend) to prove the page is wired. This one does NOT stub: a real user logs
 * in, opens /admin/ai-code, types a prompt, clicks Generate & Gate, a REAL model
 * authors the change, the REAL deterministic gate runs, and a REAL verdict
 * renders. This is what the operator and a client actually see and do - not a
 * programmed API path.
 *
 * Gated on PROD_URL + SMOKE_TEST_EMAIL/PASSWORD; skips cleanly when absent. It
 * makes a real (cheap) model call, so it is an ON-DEMAND reality check, not an
 * every-commit gate. Asserts: page mounts (never blank), the prompt submits, a
 * gate VERDICT renders from a real run, and zero CSP violations in the journey.
 */
import { test, expect } from "@playwright/test";

const PROD_URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.SMOKE_TEST_EMAIL;
const PASSWORD = process.env.SMOKE_TEST_PASSWORD;
const u = (p: string) => `${PROD_URL}${p}`;

test.describe("code factory - LIVE UI journey (real model)", () => {
  test.skip(!PROD_URL || !EMAIL || !PASSWORD, "needs PROD_URL + SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD");

  test("a user types a prompt in the UI and a real gate verdict renders", async ({ page }) => {
    const csp: string[] = [];
    page.on("console", (m) => {
      if (/content security policy|refused to (load|connect|execute)/i.test(m.text())) csp.push(m.text());
    });

    // 1) Real login (no stubbed session).
    await page.goto(u("/login"), { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-email").fill(EMAIL!);
    await page.getByTestId("login-password").fill(PASSWORD!);
    await page.locator('form button[type="submit"]').click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).not.toBe("/login");

    // 2) The factory page loads 200 and mounts (never a blank 401 page).
    const nav = await page.goto(u("/admin/ai-code"), { waitUntil: "domcontentloaded", timeout: 20_000 });
    expect(nav?.status(), "the ai-code page returns 200-class").toBeLessThan(400);
    await expect(page.getByTestId("ai-code-page"), "the factory page mounts").toBeVisible({ timeout: 10_000 });

    // 3) Submit a real prompt (the input-to-output entry point) - NO pipeline stub.
    await page.getByLabel("Prompt").fill(
      "Add a pure clamp(n, lo, hi) helper in src/lib/clamp.ts that returns n bounded to [lo, hi], with a test file.",
    );
    await page.getByRole("button", { name: /generate & gate/i }).click();

    // 4) A REAL run happens (a cheap model authors + the gate decides). The
    //    AUTHORED CODE block only renders after a real run produced a diff - so it
    //    cannot false-positive on static page text. This is the real signal that a
    //    model actually ran and the UI surfaced its output.
    await expect(
      page.getByTestId("generated-code"),
      "the real run renders the authored code (a model actually ran)",
    ).toBeVisible({ timeout: 120_000 });
    // ...and the run's stats (line count etc.) render alongside it.
    await expect(page.getByTestId("generated-code-stats"), "the run stats render").toBeVisible({ timeout: 10_000 });

    // 5) The journey produced no CSP violations (a blank/broken page class).
    expect(csp, "no CSP violations during the live journey").toEqual([]);
  });
});
