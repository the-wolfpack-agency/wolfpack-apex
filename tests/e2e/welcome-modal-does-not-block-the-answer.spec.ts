/**
 * A first visit must not leave a panel sitting on top of the answer.
 *
 * WHAT THIS CAUGHT, in real Chromium on 2026-08-30, on a flow that every unit
 * test passed:
 *
 *     focused on arrival:        TEXTAREA assistant-composer-input
 *     composer while modal open: covered by fixed inset-0 z-[60]
 *     copy button:               covered by the same backdrop
 *
 * The composer AUTOFOCUSES. So somebody arriving for the first time can type
 * their question without ever touching the welcome modal, send it, and get a
 * real answer streamed underneath a backdrop that is still there. Every
 * control on that answer, the sources, the copy button, the feedback buttons,
 * resolves to the backdrop instead of itself and silently does nothing.
 *
 * That is the worst shape this bug could take, because nothing looks broken.
 * The answer is right there, very slightly greyed, and the buttons ignore you.
 *
 * Escape and click-outside were both added earlier by measuring against the
 * live deployment, and neither helps here: somebody typing their own question
 * presses neither. jsdom cannot see it at all, because hit-testing is the
 * whole bug and jsdom has no layout.
 *
 * NEEDS A LOGIN. Skipped with a reason when no credentials are configured,
 * rather than passing quietly and looking like coverage.
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.PROD_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
/* The same two names the sibling journey specs use, and only those. A third
   local-convenience name would read as an unsupplied variable to the dormant-
   spec guardrail, which is correct of it: a spec gated on something no
   workflow provides never runs, and a skipped Playwright test reports as a
   pass. */
const EMAIL = process.env.JOURNEY_EMAIL ?? process.env.ADMIN_E2E_EMAIL;
const PASSWORD = process.env.JOURNEY_PASSWORD ?? process.env.ADMIN_E2E_PASSWORD;

test.describe("the welcome modal and a first answer", () => {
  test.skip(
    !EMAIL || !PASSWORD,
    "needs JOURNEY_EMAIL/ADMIN_E2E_EMAIL and its password. A pass without a session would not exercise the modal.",
  );

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"], input[name="email"]', EMAIL!);
    await page.fill('input[type="password"], input[name="password"]', PASSWORD!);
    const submit = page.locator('button[type="submit"]').first();
    /* The pre-hydration flake this repo has already diagnosed: a click before
       hydration does a native GET with no POST. */
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 });
    /* A fresh modal every run, so this tests the FIRST visit rather than
       whatever the previous run left in localStorage. */
    await page.evaluate(() => window.localStorage.removeItem("instinct_welcome_seen"));
  });

  test("typing your own question closes it, so the answer is usable", async ({ page }) => {
    await page.goto(`${BASE}/assistant`, { waitUntil: "domcontentloaded" });
    const composer = page.getByTestId("assistant-composer-input");
    await composer.waitFor({ timeout: 30_000 });

    /* The precondition. If the modal ever stops opening on a first visit this
       test would pass by testing nothing, so it is asserted rather than
       assumed. */
    await expect(page.locator("div.fixed.inset-0")).toHaveCount(1);

    /* Typed, not filled. fill() sets the value in one shot; a listener
       watching for somebody typing would never see it, and then this test
       would pass while the product stayed broken. */
    await page.keyboard.type("what are the payment terms in our SOW?", { delay: 10 });

    await expect(page.locator("div.fixed.inset-0")).toHaveCount(0);
  });

  test("the answer's controls are clickable, not covered", async ({ page }) => {
    await page.goto(`${BASE}/assistant`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("assistant-composer-input").waitFor({ timeout: 30_000 });
    await page.keyboard.type("what are the payment terms in our SOW?", { delay: 10 });
    await page.keyboard.press("Meta+Enter");

    const copy = page.locator('[data-testid^="copy-answer-"]').first();
    await copy.waitFor({ timeout: 120_000 });

    /* SCROLLED FIRST, because elementFromPoint answers about the VIEWPORT.
       A long answer puts this button below the fold and the hit test then
       returns null, which reads as "covered" and is really "off-screen". That
       cost a false failure on the first run of this spec: the check has to
       stand where the reader stands. */
    await copy.scrollIntoViewIfNeeded();

    /* HIT-TESTED, not just visible. "Visible" was true the whole time this bug
       existed; what was false is that a click lands on the button. */
    const covering = await copy.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (at === el) return "itself";
      if (!at) return "off-screen, so the hit test could not run";
      return String((at as HTMLElement).className || at.tagName);
    });
    expect(covering).toBe("itself");

    await copy.click();
    await expect(copy).toHaveText(/copied/i);
  });
});
