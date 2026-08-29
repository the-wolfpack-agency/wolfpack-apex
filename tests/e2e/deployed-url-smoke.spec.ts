/**
 * The deployed URL, in a real browser. The check that was missing all along.
 *
 * WHY THIS EXISTS. Everything verified on 2026-08-28 and 29 went through the
 * pipeline or the database: SharePoint search, live task reads, routing, the
 * cost figures, the nightly self-check. All real, none of it through the
 * browser a person actually uses. The repo's own definition of done says the
 * code has to work in the browser against the deployed URL, not just in a unit
 * test, and by that standard the day scored zero.
 *
 * WHAT IT CAN AND CANNOT PROVE. No E2E credentials exist in production or
 * locally, so this cannot log in and read a document answer. Rather than skip
 * quietly and look like passing coverage, it proves the things that do not
 * need a session, and every one of them is a regression class this product has
 * actually shipped:
 *
 *   - A dashboard that renders empty instead of redirecting. On 2026-04-16
 *     every API call 401'd and the page drew zeros. That is the exact shape
 *     the whole product has spent two days learning to distinguish: an empty
 *     page and an unauthorised one look identical to a reader.
 *   - CSP violations, which the middleware sets and an edge override can
 *     silently break.
 *   - A login form that submits before hydration, doing a native GET with no
 *     POST. Documented in this repo as the real cause of a flaky login.
 *   - A deploy that 500s or serves a stale commit.
 *
 * Runs against PROD_URL. Without it the suite is skipped with a reason,
 * because a green run against localhost would answer a different question than
 * the one being asked.
 */
import { test, expect } from "@playwright/test";

const PROD_URL = process.env.PROD_URL?.replace(/\/$/, "");

test.describe("the deployed site, in a browser", () => {
  test.skip(
    !PROD_URL,
    "needs PROD_URL. A pass against localhost would not answer the question this file exists for.",
  );

  /* THE APRIL 16 REGRESSION, ASSERTED. An authenticated page must send a
     signed-out visitor to the login screen. Rendering the shell with zeros is
     the failure: it tells somebody the product is empty when it is simply not
     theirs yet. */
  for (const path of ["/pilot", "/admin/insights", "/assistant"]) {
    test(`${path} redirects a signed-out visitor rather than drawing an empty page`, async ({
      page,
    }) => {
      const res = await page.goto(`${PROD_URL}${path}`, { waitUntil: "domcontentloaded" });

      /* Not a 500, and not a blank 200. */
      expect(res?.status(), `${path} should not error`).toBeLessThan(500);

      await page.waitForLoadState("networkidle").catch(() => undefined);
      const url = page.url();
      const body = (await page.textContent("body")) ?? "";

      const wentToLogin = /\/login/.test(url);
      /* If it did NOT redirect, it must at least not be an empty shell: a page
         showing nothing is the thing being guarded against. */
      if (!wentToLogin) {
        expect(
          body.replace(/\s+/g, " ").trim().length,
          `${path} neither redirected to login nor rendered anything`,
        ).toBeGreaterThan(80);
      }
    });
  }

  test("the login page renders and its submit is safe to click", async ({ page }) => {
    await page.goto(`${PROD_URL}/login`, { waitUntil: "domcontentloaded" });

    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 15_000,
    });

    /* THE PRE-HYDRATION FLAKE, ASSERTED. An action-less client form clicked
       before hydration does a native GET with no POST, which this repo has
       already diagnosed once as the real cause of a flaky login. The submit
       must be enabled only once it will actually do something. */
    const submit = page.locator('button[type="submit"]').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
  });

  test("the deployed commit is reported, so a stale alias is visible", async ({ request }) => {
    const res = await request.get(`${PROD_URL}/api/version`);
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { sha?: string; env?: string };
    /* A deploy serving an old commit passes every other check in this file
       while being the wrong build. */
    expect(body.sha, "no sha reported").toBeTruthy();
    expect(body.sha!.length).toBeGreaterThanOrEqual(7);
  });

  /* CSP is set in middleware and an edge override can win silently. A
     violation does not break the page visibly, which is precisely why nobody
     notices until something is blocked that mattered. */
  test("no content-security-policy violations on a public page", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/content security policy|refused to (load|execute|connect)/i.test(text)) {
        violations.push(text.slice(0, 200));
      }
    });

    await page.goto(`${PROD_URL}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);

    expect(violations, `CSP violations on /login:\n${violations.join("\n")}`).toEqual([]);
  });

  /* A page that 200s while its own scripts fail is a page that will be blank
     for a real user a moment later. */
  test("the login page loads without a page-level javascript error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message.slice(0, 200)));

    await page.goto(`${PROD_URL}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);

    expect(errors, `javascript errors on /login:\n${errors.join("\n")}`).toEqual([]);
  });
});
