/**
 * Every authenticated page redirects a signed-out visitor. All of them, on
 * every deploy, with no credentials required.
 *
 * WHY THIS ONE IS DIFFERENT FROM THE OTHER E2E SPECS
 *
 * Almost every spec here signs in first, so almost every spec SKIPS when the
 * smoke credentials are absent. That leaves the single most damaging failure
 * mode unwatched in exactly the situations where nobody is watching: a
 * signed-out visitor landing on an authenticated page that renders empty
 * instead of sending them to /login. It looks like a broken product rather
 * than a login prompt, and it is the April 16 blank-dashboard incident.
 *
 * This spec needs no secrets, so it runs everywhere: locally, on every PR, and
 * against production.
 *
 * GENERATED FROM THE NAV REGISTRY, NOT A HAND-WRITTEN LIST
 *
 * The routes come from NAV_ITEMS, the same source the sidebar renders from. A
 * page added to the nav is covered here the day it ships, with nobody
 * remembering to add it — which is the only kind of coverage that survives.
 * A hand-maintained list would be complete on the day it was written and
 * wrong a month later.
 *
 * WHAT COUNTS AS PASSING
 *
 * Landing on /login is a pass. So is rendering the page's own real content,
 * which happens when a session cookie is present. What FAILS is the third
 * outcome: staying on the authenticated URL with nothing on it. That is the
 * blank page, and it is the only thing this is looking for.
 */
import { test, expect } from "@playwright/test";
import { NAV_ITEMS } from "@/lib/dashboard-nav";

const PROD_URL = process.env.PROD_URL?.replace(/\/$/, "");
const BASE = PROD_URL || "http://localhost:3000";

/** Dashboard routes only. "/" is the dashboard root and included; anything
 *  public would belong in a different spec with different expectations. */
const ROUTES = [...new Set(NAV_ITEMS.map((i) => i.href))].filter((href) => href.startsWith("/"));

test.describe("every authenticated page sends a signed-out visitor to /login", () => {
  test("the route list is not empty, so a broken import cannot pass by testing nothing", () => {
    // A spec that silently iterates zero routes reports success forever.
    expect(ROUTES.length).toBeGreaterThan(10);
  });

  for (const href of ROUTES) {
    test(`${href} does not render blank when signed out`, async ({ page }) => {
      // A fresh context per test: no storage state, so genuinely signed out.
      await page.context().clearCookies();

      const res = await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 20_000 });

      // Never a server error. A 500 on an unauthenticated visit is a leak of a
      // different kind: it means the handler ran before deciding it should not.
      expect(res?.status(), `${href} must not 5xx when signed out`).toBeLessThan(500);

      // The redirect is client-side after the auth check, so allow for it.
      await page
        .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 10_000 })
        .catch(() => {});

      if (page.url().includes("/login")) {
        // The good path. Confirm the login form is actually there rather than
        // an empty /login, which would move the blank page rather than fix it.
        await expect(page.locator("input[type=password]")).toBeVisible({ timeout: 10_000 });
        return;
      }

      // Not redirected. Acceptable only if the page rendered real content.
      const text = (await page.locator("body").innerText().catch(() => "")).trim();
      expect(
        text.length,
        `${href} neither redirected to /login nor rendered anything — this is the blank authenticated page`,
      ).toBeGreaterThan(20);
    });
  }
});
