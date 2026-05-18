/**
 * Alicia's first day with Instinct — E2E verification of the PM rollout path.
 *
 * What this spec proves end-to-end (real browser):
 *
 *   1. Alicia (role=pm) lands on /assistant for the first time.
 *   2. The welcome modal renders with HER three prompts:
 *        - briefing
 *        - what is on my calendar today
 *        - create task to <thing> by friday
 *   3. Clicking "briefing" fills the composer + dismisses the modal +
 *      fires assistant.welcome_prompt_clicked analytics.
 *   4. Sending "briefing" returns the good-morning widget inline.
 *   5. The chip tooltips on the empty-state grid carry non-empty
 *      `title` attributes so hovering explains each prompt.
 *   6. A SECOND visit (same browser, modal flag set) does NOT re-show
 *      the welcome modal.
 *   7. When the assistant returns `fallbackChips`, the bubble renders
 *      a clickable chip row beneath the message.
 *
 * The chat API is mocked end-to-end so this spec is deterministic and
 * doesn't depend on backend wiring. Real session is stubbed via
 * stubInstinctSession(role: "pm"). Runs against any baseUrl —
 * local dev or deployed Vercel URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Alicia (PM) — first-day journey", () => {
  test.beforeEach(async ({ page }) => {
    /* Stub Alicia as the signed-in user. The chat infers role from
     * localStorage.instinct_user; the welcome modal reads role from
     * that same blob, so this is enough to drive the PM kit. */
    await stubInstinctSession(page, {
      id: "u-alicia",
      role: "pm",
      name: "Alicia",
      email: "alicia@thewolfpack.agency",
    });
  });

  test("welcome modal shows PM kit on first visit, picking a prompt fills composer + dismisses + sends a briefing", async ({
    page,
  }) => {
    /* Mock the chat conversations + send endpoints so the test is
     * deterministic without backend wiring. */
    await page.route("**/api/assistant?conversations=true", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [] }),
      });
    });
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            response: "Good morning, Alicia.",
            source: "tool",
            tokensUsed: 0,
            conversationId: "c-test",
            messageId: "m-test",
            workflowId: "wf-test",
            widget: {
              kind: "good_morning",
              greeting: "Good morning, Alicia.",
              summary: "Nothing on your plate yet.",
              schedule: { eventCount: 0, events: [] },
              actionItems: [],
              connected: true,
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });
    /* Swallow analytics POSTs so the route handler doesn't 404 in
     * the test. We assert via console / network watching below. */
    const analyticsEvents: string[] = [];
    await page.route("**/api/analytics", async (route) => {
      try {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.event) analyticsEvents.push(body.event);
      } catch {
        /* ignore non-JSON */
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    const res = await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(400);

    /* Welcome modal is visible with Alicia's name. */
    await expect(page.getByTestId("assistant-welcome-modal")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/Hi Alicia/)).toBeVisible();

    /* PM kit prompts. */
    await expect(page.getByText("briefing", { exact: true })).toBeVisible();
    await expect(page.getByText("what is on my calendar today")).toBeVisible();
    await expect(page.getByText(/create task to/)).toBeVisible();

    /* Pick "briefing". */
    await page.getByText("briefing", { exact: true }).click();

    /* Modal closed; composer filled. */
    await expect(page.getByTestId("assistant-welcome-modal")).not.toBeVisible();
    const composer = page.getByTestId("assistant-composer-input");
    await expect(composer).toHaveValue("briefing");

    /* Analytics fired for the pick. */
    expect(analyticsEvents).toContain("assistant.welcome_shown");
    expect(analyticsEvents).toContain("assistant.welcome_prompt_clicked");

    /* Hit Send. */
    await page.getByTestId("assistant-send-btn").click();

    /* Good-morning widget renders. The greeting appears twice (once
     * in the message bubble, once inside the widget) — we assert the
     * WIDGET specifically so we know the render path landed, not just
     * the text response. */
    await expect(page.getByTestId("good-morning-widget")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("starter chips carry hover tooltips (non-empty title attributes)", async ({
    page,
  }) => {
    /* Stub /api/integrations/status so chip filtering doesn't hide
     * everything. PM gets the gated categories (microsoft etc.). */
    await page.route("**/api/integrations/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          microsoft: { connected: true },
          salesforce: { connected: true },
          github: { connected: true },
          quickbooks: { connected: false },
          plaud: { connected: false, configured: false },
          hubspot: { connected: false },
        }),
      });
    });
    await page.route("**/api/assistant?conversations=true", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [] }),
      });
    });
    await page.route("**/api/analytics", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    /* Pre-set the welcome flag so the modal doesn't obscure the chip grid. */
    await page.addInitScript(() => {
      try {
        localStorage.setItem("instinct_welcome_seen", "1");
      } catch {
        /* private mode — ignore */
      }
    });

    await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
    });

    /* Wait for at least one chip to render. */
    const chipLocator = page.locator('button[data-testid^="starter-prompt-"]');
    await expect(chipLocator.first()).toBeVisible({ timeout: 10_000 });

    /* Every visible chip must carry a non-empty title (hover tooltip). */
    const chips = await chipLocator.all();
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const title = await chip.getAttribute("title");
      expect(title?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  test("second visit does NOT re-show the welcome modal", async ({ page }) => {
    /* Pre-set the storage flag — simulates "Alicia has already seen
     * the welcome once". */
    await page.addInitScript(() => {
      try {
        localStorage.setItem("instinct_welcome_seen", "1");
      } catch {
        /* private mode — ignore */
      }
    });
    await page.route("**/api/assistant?conversations=true", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [] }),
      });
    });
    await page.route("**/api/analytics", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
    });

    /* Give the modal effect a chance to attempt render. */
    await page.waitForTimeout(500);
    await expect(page.getByTestId("assistant-welcome-modal")).not.toBeVisible();
  });

  test("fallback chips render when server includes them on a low-confidence response", async ({
    page,
  }) => {
    /* Pre-dismiss welcome modal so we go straight to chat. */
    await page.addInitScript(() => {
      try {
        localStorage.setItem("instinct_welcome_seen", "1");
      } catch {
        /* ignore */
      }
    });
    await page.route("**/api/assistant?conversations=true", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [] }),
      });
    });
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            response:
              "I'm not sure how to help with that yet. Try one of these instead:",
            source: "fallback",
            tokensUsed: 0,
            conversationId: "c-test",
            messageId: "m-test",
            workflowId: "wf-test",
            fallbackChips: [
              "briefing",
              "what is on my calendar today",
              "create task to <thing> by friday",
            ],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.route("**/api/analytics", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
    });

    const composer = page.getByTestId("assistant-composer-input");
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("asdfgh quantum dolphin");
    await page.getByTestId("assistant-send-btn").click();

    /* Fallback chip row appears under the bubble. */
    await expect(page.getByTestId("assistant-fallback-chips")).toBeVisible({
      timeout: 10_000,
    });

    /* Clicking a fallback chip fills the composer with that prompt. */
    await page.getByText("briefing", { exact: true }).first().click();
    await expect(composer).toHaveValue("briefing");
  });
});
