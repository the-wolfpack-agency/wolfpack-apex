/**
 * "Not connected to Microsoft" is not an expired session, through the UI.
 *
 * The post-merge run of 2026-10-25 (emails-inbox-flow) showed, on every visit
 * to /emails by the smoke user (no Microsoft connection):
 *   - GET /api/emails/inbox -> 401, then fetchWithRefresh rotated the refresh
 *     token and retried -> 401 again;
 *   - POST /api/analytics -> 401 (a beacon sent without the Bearer token).
 *
 * Contract this spec holds on the deployed URL:
 *   1. No request on these pages answers 401 while signed in.
 *   2. No POST /api/auth/refresh is triggered by a provider answer.
 *   3. GET /api/emails/inbox is 200; when the account has no Microsoft
 *      connection the body says connected:false and the inbox renders the
 *      connect prompt (never a blank widget, never a redirect to /login).
 *   4. No console errors.
 * Scenarios: desktop + mobile viewport, a reload, and three Graph-backed pages.
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const PAGES = ["/emails", "/tasks", "/planner"];

function watch(page: Page) {
  const unauthorized: string[] = [];
  const refreshes: string[] = [];
  const consoleErrors: string[] = [];
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes("/api/")) return;
    if (url.includes("/api/auth/refresh")) refreshes.push(`${res.status()} ${url}`);
    if (res.status() === 401) unauthorized.push(`${res.request().method()} ${url}`);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/Download the React DevTools|\[Fast Refresh\]/i.test(msg.text())) return;
    const where = msg.location()?.url;
    consoleErrors.push(where ? `${msg.text()} [${where}]` : msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  return { unauthorized, refreshes, consoleErrors };
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
}

test.describe("provider not connected never reads as a signed-out session", () => {
  test.beforeEach(async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping");
      return;
    }
    expect(await signInIfPossible(page, target)).toBe(true);
    // Let the post-login landing page finish its own requests before watching.
    await settle(page);
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`${viewport.name}: Graph-backed pages make no 401 and no refresh`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seen = watch(page);
      for (const path of PAGES) {
        const res = await page.goto(`${target.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
        expect(res?.status(), `${path} document`).toBe(200);
        await settle(page);
        expect(new URL(page.url()).pathname, `${path} must not bounce to /login`).toBe(path);
      }
      expect(seen.unauthorized, "401s while signed in").toEqual([]);
      expect(seen.refreshes, "refresh-token rotations").toEqual([]);
      expect(seen.consoleErrors, "console errors").toEqual([]);
    });
  }

  test("/emails: inbox answers 200 and renders rows, an empty state, or the connect prompt; survives reload", async ({
    page,
  }) => {
    const seen = watch(page);
    const inboxResponse = page.waitForResponse((r) => r.url().includes("/api/emails/inbox"));
    await page.goto(`${target.baseUrl}/emails`, { waitUntil: "domcontentloaded" });
    const res = await inboxResponse;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { connected?: boolean; messages?: unknown[] };
    await settle(page);

    if (body.connected === false) {
      const err = page.getByTestId("inbox-error");
      await expect(err).toBeVisible();
      await expect(err).toHaveAttribute("data-code", "not_connected");
      await expect(page.getByText(/Connect Microsoft 365 to see your inbox/i)).toBeVisible();
    } else {
      expect(Array.isArray(body.messages)).toBe(true);
      await expect(page.getByTestId("inbox-panel")).toBeVisible();
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page);
    expect(new URL(page.url()).pathname).toBe("/emails");
    await expect(page.getByTestId("inbox-panel")).toBeVisible();

    expect(seen.unauthorized, "401s while signed in").toEqual([]);
    expect(seen.refreshes, "refresh-token rotations").toEqual([]);
    expect(seen.consoleErrors, "console errors").toEqual([]);
  });
});
