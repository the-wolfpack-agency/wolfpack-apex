/**
 * E2E: clarify widget end-to-end against the deployed assistant.
 * Mocks /api/assistant to return a clarify widget spec for the first
 * POST (the typo), then a different widget for the second POST (the
 * corrected query that the chip-click triggers). Asserts the chip
 * click actually re-fires the corrected prompt without manual typing.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
} from "./helpers/smoke-helpers";
import { submitComposer } from "./helpers/assistant-composer";

const target = resolveSmokeTarget();

const CLARIFY_RESPONSE = {
  response: "Did you mean one of these? Tap a chip to run it.",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-cl-1",
  messageId: "m-cl-1",
  workflowId: "wf-cl-1",
  widget: {
    kind: "clarify",
    title: "Did you mean…?",
    originalQuery: "insighta",
    suggestions: [
      {
        label: "insights",
        query: "insights",
        hint: "Cross-tool insights across all your integrations",
      },
      {
        label: "calendar",
        query: "calendar",
        hint: "What's on your calendar today",
      },
    ],
  },
};

const CTI_AFTER_CLICK_RESPONSE = {
  response: "Found 1 cross-tool insight (1 high-signal).",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-cl-1",
  messageId: "m-cl-2",
  workflowId: "wf-cl-2",
  widget: {
    kind: "cross_tool_insights",
    title: "1 cross-tool insight",
    subtitle: "Across 2 integrations, 4 of 4 patterns checked.",
    lookbackDays: 30,
    items: [
      {
        id: "team_momentum_brief:2026-05-24",
        generator: "team_momentum_brief",
        severity: "low",
        signalStrength: 30,
        title: "This week: 4 PRs merged across 2 repos",
        detail: null,
        action: null,
        sources: ["github", "vercel"],
      },
    ],
    generatorOutcomes: [],
  },
};

test.describe("Clarify widget (typo → chip → autosubmit)", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, {
      id: "u-clar",
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
    await page.route("**/api/assistant?conversationId=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversationId: "c-cl-1", messages: [] }),
      });
    });
  });

  test("typing a typo shows clarify chips; clicking one auto-fires the corrected query", async ({
    page,
  }) => {
    let postCount = 0;
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        postCount += 1;
        const body = postCount === 1 ? CLARIFY_RESPONSE : CTI_AFTER_CLICK_RESPONSE;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
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
    if (await welcomeClose.isVisible().catch(() => false)) await welcomeClose.click();

    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("insighta");
    await submitComposer(page);

    // Clarify widget appears with chips for "insights" and "calendar"
    await expect(page.getByTestId("clarify-widget")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("clarify-suggestion-insights"),
    ).toBeVisible();
    await expect(
      page.getByTestId("clarify-suggestion-calendar"),
    ).toBeVisible();

    // Click the "insights" chip — this should auto-fire a NEW POST
    // to /api/assistant with prompt="insights", and the cross-tool
    // insights widget should render in response.
    await page.getByTestId("clarify-suggestion-insights").click();

    await expect(
      page.getByTestId("cross-tool-insights-widget"),
    ).toBeVisible({ timeout: 10_000 });
    expect(postCount).toBe(2);
  });
});
