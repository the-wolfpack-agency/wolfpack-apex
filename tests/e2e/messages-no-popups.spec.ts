/**
 * Message pop-ups are off (2026-11-11), E2E.
 *
 * The in-app "new message" toast and the desktop notification fired on every
 * unread-count increase, including the operator's own sent messages, and were
 * removed as noise. What stays: the unread badge in the top bar and the "(N)"
 * tab-title count. This drives the real page bundle in a real browser with a
 * stubbed session and the unread-count API growing between polls (the exact
 * trigger the pop-ups used), then asserts:
 *   - the page and the unread-count API answer 200 (not 401 / blank)
 *   - the badge and the tab title follow the count
 *   - no toast renders, and the Notification API is never constructed and
 *     never asks for permission
 *   - no console errors, page errors or CSP violations
 * Also: phone width, and reload.
 *
 * Run locally against a production build (dev-mode CSP blocks hydration):
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/messages-no-popups.spec.ts
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
// A layout page whose own data the spec stubs, so nothing unrelated 401s.
const PATH = "/admin/site-analytics";
const POLL_MS = 61_000;

/** Count the Notification API calls the page makes (it should make none). */
async function spyOnNotifications(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __notif: { constructed: number; asked: number }; Notification: unknown };
    w.__notif = { constructed: 0, asked: 0 };
    function FakeNotification() { w.__notif.constructed++; }
    (FakeNotification as unknown as { permission: string }).permission = "granted";
    (FakeNotification as unknown as { requestPermission: () => Promise<string> }).requestPermission = () => {
      w.__notif.asked++;
      return Promise.resolve("granted");
    };
    w.Notification = FakeNotification;
  });
}

async function stubPage(page: Page, counts: number[]): Promise<{ hits: () => number }> {
  let hits = 0;
  await page.route(/\/api\/ms\/chats\/unread-count/, async (route: Route) => {
    const count = counts[Math.min(hits, counts.length - 1)];
    hits++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ count, total_chats: 25, connected: true }) });
  });
  // the board page's own data: an empty, valid summary
  await page.route(/\/api\/admin\/site-analytics(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "not needed" }) }),
  );
  await page.route(/\/api\/admin\/forcefield\/(edge-policy|reputation-optin)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  return { hits: () => hits };
}

async function open(page: Page): Promise<void> {
  const unread = page.waitForResponse((r) => /\/api\/ms\/chats\/unread-count/.test(r.url()));
  const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), `${PATH} loads 200`).toBe(200);
  expect((await unread).status(), "unread-count answers 200").toBe(200);
}

async function notifCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __notif: { constructed: number; asked: number } }).__notif);
}

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  // the board's stubbed summary is deliberately empty; only browser-level failures matter here
  const failures = snapshot().filter((f) => f.kind === "console" || /csp/i.test(f.detail));
  expect(failures, failures.map((f) => `[${f.kind}] ${f.detail}`).join("\n")).toEqual([]);
}

test.describe("message pop-ups are off", () => {
  test.use({ serviceWorkers: "block" });

  test("new messages update the badge and tab title, with no toast and no desktop notification", async ({ page }) => {
    await page.clock.install();
    await stubInstinctSession(page, { role: "cto" });
    await spyOnNotifications(page);
    const unread = await stubPage(page, [1, 4, 6]);
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);

    await expect(page.locator("[data-testid=teams-unread-badge]:visible").first()).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveTitle(/^\(1\) /);

    // two more polls, each a larger count: exactly what used to pop up
    for (const n of [4, 6]) {
      const before = unread.hits();
      await page.clock.fastForward(POLL_MS);
      await expect.poll(() => unread.hits()).toBeGreaterThan(before);
      await expect(page).toHaveTitle(new RegExp(`^\\(${n}\\) `));
    }

    await expect(page.getByTestId("new-message-toast")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: /new (teams )?message/i })).toHaveCount(0);
    expect(await notifCalls(page)).toEqual({ constructed: 0, asked: 0 });
    expectNoFailures(snapshot);
  });

  test("reload keeps it quiet", async ({ page }) => {
    await page.clock.install();
    await stubInstinctSession(page, { role: "cto" });
    await spyOnNotifications(page);
    const unread = await stubPage(page, [2, 3]);
    await open(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-testid=teams-unread-badge]:visible").first()).toBeVisible({ timeout: 30_000 });
    const before = unread.hits();
    await page.clock.fastForward(POLL_MS);
    await expect.poll(() => unread.hits()).toBeGreaterThan(before);
    await expect(page.getByTestId("new-message-toast")).toHaveCount(0);
    expect(await notifCalls(page)).toEqual({ constructed: 0, asked: 0 });
  });

  test("phone width: no toast, no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    await stubInstinctSession(page, { role: "cto" });
    await spyOnNotifications(page);
    const unread = await stubPage(page, [1, 5]);
    await open(page);
    const before = unread.hits();
    await page.clock.fastForward(POLL_MS);
    await expect.poll(() => unread.hits()).toBeGreaterThan(before);
    await expect(page.getByTestId("new-message-toast")).toHaveCount(0);
    expect(await notifCalls(page)).toEqual({ constructed: 0, asked: 0 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
