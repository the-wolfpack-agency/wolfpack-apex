/**
 * The client-build section, in a real browser.
 *
 * WHAT IT GUARDS. The section exists so a page built for one client cannot be
 * mistaken for a shipped feature, and the whole mechanism is one banner. A
 * banner that renders as unstyled text, or that gets clipped, or that a CSP
 * rule blanks, fails silently: the page still looks fine, and the one sentence
 * that stops a concept being demoed as a product is gone.
 *
 * Runs against BASE_URL (a local dev server or the deployed site). The session
 * is stubbed because the pages are behind the authenticated shell and no E2E
 * credentials exist; nothing here reads a user's data, so a stub answers the
 * question honestly.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
  expectRendered,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("client builds", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page);
  });

  test("the register lists the builds and says what each one's numbers are", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    const res = await page.goto(`${target.baseUrl}/builds`, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "/builds should serve").toBeLessThan(400);

    await expectRendered(page, "/builds", ["work in flight"]);

    const list = page.getByTestId("builds-list");
    await expect(list).toContainText("Phase One");
    await expect(list).toContainText("Change Management Plan");
    /* The line that distinguishes a measurement from a drawing, on the page
       somebody uses to decide what to open. */
    await expect(list).toContainText(/measured against our own/i);
    await expect(list).toContainText(/Nothing is wired/i);

    const csp = failures().filter((f) => f.detail.startsWith("CSP:"));
    expect(csp, `CSP violations on /builds:\n${csp.map((f) => f.detail).join("\n")}`).toEqual([]);
  });

  /* THE MECHANISM, ASSERTED. Every build page carries the marker, including
     when the link is shared without the register around it. */
  for (const path of ["/pilot", "/builds/change-management", "/builds/course-program"]) {
    test(`${path} carries the client-build marker`, async ({ page }) => {
      await page.goto(`${target.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      const banner = page.getByTestId("build-banner");
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("build-banner-stage")).not.toBeEmpty();
      await expect(page.getByTestId("build-banner-data")).not.toBeEmpty();

      /* Styled, not just present. An unstyled banner reads as a stray
         sentence and stops doing the one job it has. */
      const border = await banner.evaluate(
        (el) => getComputedStyle(el).borderLeftWidth,
      );
      expect(border, `${path} banner is unstyled`).not.toBe("0px");
    });
  }

  test("the concept page renders its argument, not an empty shell", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    await page.goto(`${target.baseUrl}/builds/change-management`, {
      waitUntil: "domcontentloaded",
    });

    await expectRendered(page, "/builds/change-management", ["change management plan"]);

    /* Their own words, the finding, and the admission. If any of the three is
       missing the page is a pitch rather than a document. */
    await expect(page.getByTestId("cm-their-words")).toContainText(/share your plan with managers/i);
    await expect(page.getByTestId("cm-findings")).toContainText(/39 screens walked/i);
    await expect(page.getByTestId("cm-open")).toContainText(/what does the plan actually ask/i);

    /* Four moments, three of which a form cannot hold. */
    await expect(page.locator(".wp-build-flow--loose")).toHaveCount(3);

    expect(failures().filter((f) => f.detail.startsWith("CSP:"))).toEqual([]);
  });

  /* THE CONSTRAINT HAS TO SURVIVE A DEPLOY. Everything else on that page is
     downstream of the client owning their material, and a reader who misses it
     starts imagining slides. */
  test("the new-course page leads with what we cannot take", async ({ page }) => {
    await page.goto(`${target.baseUrl}/builds/course-program`, { waitUntil: "domcontentloaded" });
    await expectRendered(page, "/builds/course-program", ["taking the method"]);

    await expect(page.getByTestId("cp-ip")).toContainText(/cannot be copied or distributed/i);
    await expect(page.getByTestId("cp-open")).toContainText(/who is the client/i);
    /* Six rungs, in order. The order is the finding. */
    await expect(page.locator('[data-testid="cp-ladder"] li')).toHaveCount(6);
  });

  /* A wide table is the classic way a document page starts scrolling
     sideways on a laptop, and nobody notices until a client opens it. */
  test("the page body never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    for (const path of ["/builds/change-management", "/builds/course-program"]) {
      await page.goto(`${target.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      await expectRendered(page, path, ["change management plan", "taking the method"]);
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(wide, `${path} scrolls horizontally`).toBeLessThanOrEqual(1);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls horizontally").toBeLessThanOrEqual(1);
  });
});
