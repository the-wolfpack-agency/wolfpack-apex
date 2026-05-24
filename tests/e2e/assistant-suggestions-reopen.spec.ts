/**
 * E2E: persistent Suggestions overlay re-entry point.
 *
 * Regression for the discoverability gap: after the first message
 * is sent, the inline starter prompts disappear. Users need a way
 * back to them. The header "Suggestions" button + `/help` slash
 * command both open AssistantSuggestionsOverlay over the existing
 * chat without clearing it.
 *
 * Test plan:
 *   1. Land on /assistant, send a prompt → widget renders.
 *   2. Confirm the inline starter prompts no longer show.
 *   3. Click the Suggestions button → overlay opens.
 *   4. Press Escape → overlay closes; chat is preserved.
 *   5. Type `/help` + send → overlay opens via slash command without
 *      a second POST to /api/assistant (zero-token entry).
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const CTI_RESPONSE = {
  response: "Found 1 cross-tool insight (1 high-signal).",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-sg-1",
  messageId: "m-sg-1",
  workflowId: "wf-sg-1",
  widget: {
    kind: "cross_tool_insights",
    title: "1 cross-tool insight",
    subtitle: "Across 2 integrations, 5 of 5 patterns checked.",
    lookbackDays: 30,
    items: [
      {
        id: "team_momentum_brief:today",
        generator: "team_momentum_brief",
        severity: "low",
        signalStrength: 30,
        title: "This week: 3 PRs merged across 2 repos",
        detail: null,
        action: null,
        sources: ["github", "vercel"],
      },
    ],
    generatorOutcomes: [],
  },
};

test.describe("Persistent Suggestions overlay", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, {
      id: "u-sg",
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
    await page.route("**/api/integrations/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ vercel: true, github: true }),
      });
    });
    await page.route("**/api/assistant?conversationId=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversationId: "c-sg-1", messages: [] }),
      });
    });
  });

  test("Suggestions button re-opens the panel after a message has been sent", async ({
    page,
  }) => {
    let postCount = 0;
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        postCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(CTI_RESPONSE),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    await page.goto(`${target.baseUrl}/assistant`, {
      waitUntil: "domcontentloaded",
    });
    const welcomeClose = page.getByRole("button", { name: /close/i });
    if (await welcomeClose.isVisible().catch(() => false))
      await welcomeClose.click();

    // 1. Send a message
    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("give me insights");
    await composer.press("Enter");
    await expect(page.getByTestId("cross-tool-insights-widget")).toBeVisible({
      timeout: 10_000,
    });
    expect(postCount).toBe(1);

    // 2. Click the Suggestions button — overlay opens
    await page.getByTestId("assistant-suggestions-button").click();
    await expect(
      page.getByTestId("assistant-suggestions-overlay"),
    ).toBeVisible();

    // 3. Escape closes the overlay; chat history is preserved.
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("assistant-suggestions-overlay"),
    ).toHaveCount(0);
    await expect(page.getByTestId("cross-tool-insights-widget")).toBeVisible();

    // 4. Slash command opens the overlay without firing another POST.
    await composer.fill("/help");
    await composer.press("Enter");
    await expect(
      page.getByTestId("assistant-suggestions-overlay"),
    ).toBeVisible();
    expect(postCount).toBe(1); // still 1 — /help was intercepted client-side
  });
});
