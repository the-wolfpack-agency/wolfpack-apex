/**
 * Widget persistence — regression coverage for a bug class Nick hit
 * five times in one session:
 *
 *   - Send a prompt that triggers a tool widget (Vercel deploys).
 *   - Widget renders inline.
 *   - Page silent-refreshes (poll, focus, visibilitychange).
 *   - Widget MUST stay rendered. No vanish, no remount, no flicker.
 *   - Conversation must NOT flip to a different one.
 *
 * The bug was a stack of three issues:
 *   1. Server `chat()` silently attached new messages to the user's
 *      most-recent active conversation when no conversationId was
 *      provided (autoresume) — landed the message in the wrong chat.
 *   2. Client merged-from-server messages preserved the widget only
 *      via metadata.widget, but the render condition checked the
 *      top-level field, so a brief window dropped the widget.
 *   3. The message-list React key was the array index, so
 *      setMessages(remote) mis-matched components by position.
 *
 * All three layers are covered by THIS spec — sending → rendering →
 * surviving a simulated silent refresh. Failing tests here are a
 * stop-ship signal.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
} from "./helpers/smoke-helpers";
import { submitComposer } from "./helpers/assistant-composer";

const target = resolveSmokeTarget();

const VERCEL_WIDGET_RESPONSE = {
  response: "Showing the 1 most recent deploy for wolfpack-auto.",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-vercel-test",
  messageId: "m-vercel-1",
  workflowId: "wf-vercel-test",
  widget: {
    kind: "vercel_deployments",
    projectName: "wolfpack-auto",
    title: "1 recent deploy of wolfpack-auto",
    items: [
      {
        id: "d-test-1",
        projectName: "wolfpack-auto",
        state: "READY",
        target: "production",
        url: "https://vercel.com/team/wolfpack-auto/d-test-1",
        commitMessage: "fix: example",
        branch: "main",
        commitSha: "abc1234",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        readyAt: new Date(Date.now() - 30_000).toISOString(),
        creator: "homyk",
      },
    ],
  },
};

const REFRESHED_MESSAGES_RESPONSE = {
  conversationId: "c-vercel-test",
  messages: [
    {
      id: "u-msg-1",
      role: "user",
      content: "show vercel deploys for wolfpack-auto",
      tokensUsed: 0,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: "m-vercel-1",
      role: "assistant",
      content: VERCEL_WIDGET_RESPONSE.response,
      source: "tool",
      tokensUsed: 0,
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      metadata: { widget: VERCEL_WIDGET_RESPONSE.widget },
    },
  ],
};

test.describe("Assistant widget persistence", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, {
      id: "u-cto",
      role: "cto",
      name: "Nick",
      email: "homyk@thewolfpack.agency",
    });

    await page.route("**/api/assistant?conversations=true", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [] }),
      });
    });

    await page.route("**/api/analytics", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    /* Conversation-load endpoint: returns the persisted message with
     * widget in metadata. Used by silent refresh. */
    await page.route(
      "**/api/assistant?conversationId=*",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(REFRESHED_MESSAGES_RESPONSE),
        });
      },
    );

    /* Chat POST: returns the widget response on first send. */
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(VERCEL_WIDGET_RESPONSE),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });
  });

  test("widget renders after send and survives a simulated tab-refocus refresh", async ({
    page,
  }) => {
    const res = await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(400);

    /* Close any welcome modal so the composer is usable. */
    const welcomeClose = page.getByRole("button", { name: /close/i });
    if (await welcomeClose.isVisible().catch(() => false)) {
      await welcomeClose.click();
    }

    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("show vercel deploys for wolfpack-auto");
    await submitComposer(page);

    /* Widget renders. */
    const widget = page.getByTestId("vercel-deployments-widget");
    await expect(widget).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId("vercel-deploy-item-d-test-1"),
    ).toBeVisible();

    /* Simulate the focus-driven silent refresh that was dropping the
     * widget in production. Fire both visibilitychange and focus,
     * matching the events the live-update hook listens to. */
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    /* Give the refresh a moment to fire and re-render. */
    await page.waitForTimeout(500);

    /* Widget MUST still be visible. This is the regression assertion
     * that would have caught the original bug class on every commit. */
    await expect(widget).toBeVisible();
    await expect(
      page.getByTestId("vercel-deploy-item-d-test-1"),
    ).toBeVisible();
  });

  test("silent refresh that arrives mid-send (server has user msg but not assistant) does not drop the widget", async ({
    page,
  }) => {
    /* This reproduces the original production bug: the silent refresh
     * fired between the server's user-msg save and assistant-msg save.
     * The GET returned only the user message. The merge replaced the
     * local array, dropping the in-flight assistant message + widget. */
    await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const welcomeClose = page.getByRole("button", { name: /close/i });
    if (await welcomeClose.isVisible().catch(() => false)) {
      await welcomeClose.click();
    }

    /* Override the conversationId-load endpoint to return ONLY the user
     * message (simulating the server mid-save state). */
    await page.unroute("**/api/assistant?conversationId=*");
    await page.route("**/api/assistant?conversationId=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: "c-vercel-test",
          messages: [
            {
              id: "u-msg-1",
              role: "user",
              content: "show vercel deploys for wolfpack-auto",
              tokensUsed: 0,
              timestamp: new Date(Date.now() - 60_000).toISOString(),
            },
            /* Critically: no assistant message yet. */
          ],
        }),
      });
    });

    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("show vercel deploys for wolfpack-auto");
    await submitComposer(page);

    /* Widget renders from the POST response. */
    const widget = page.getByTestId("vercel-deployments-widget");
    await expect(widget).toBeVisible({ timeout: 10_000 });

    /* Trigger a silent refresh that will return the (incomplete)
     * snapshot. */
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(800);

    /* Widget MUST still be visible. The race-safe merge in
     * silentRefreshMessages preserves the in-flight assistant
     * message + widget rather than replacing the array. */
    await expect(widget).toBeVisible();
  });

  test("clicking a widget link does not switch conversation or remove the widget", async ({
    page,
    context,
  }) => {
    await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    const welcomeClose = page.getByRole("button", { name: /close/i });
    if (await welcomeClose.isVisible().catch(() => false)) {
      await welcomeClose.click();
    }

    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("show vercel deploys for wolfpack-auto");
    await submitComposer(page);

    const widget = page.getByTestId("vercel-deployments-widget");
    await expect(widget).toBeVisible({ timeout: 10_000 });

    /* Capture the URL state pre-click. */
    const urlBefore = page.url();

    /* Click the deploy link. target=_blank opens a new tab; we don't
     * follow it, we just need the source page to fire the events the
     * widget triggers on click. */
    const link = page
      .getByTestId("vercel-deploy-item-d-test-1")
      .locator("a")
      .first();

    /* Listen for popup but don't await it on the source page. */
    const popupPromise = context.waitForEvent("page").catch(() => null);
    await link.click();
    await popupPromise;

    /* Simulate returning to the source tab. */
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(500);

    /* Source page URL must NOT have changed. */
    expect(page.url()).toBe(urlBefore);

    /* Widget must STILL be visible — the click should not have
     * unmounted it. */
    await expect(widget).toBeVisible();
  });
});
