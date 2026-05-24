/**
 * E2E coverage matrix — the top user prompts that ship as
 * client-facing functionality on /assistant. For each prompt we
 * stub /api/assistant to return the canonical widget spec for that
 * intent, type the prompt, and assert the widget renders.
 *
 * Why a matrix and not one spec per prompt: each entry is a single
 * regression guardrail — if any future change breaks a tool→widget
 * trigger or a renderer testid, exactly one row goes red and the
 * failure message names the broken prompt.
 *
 * Some prompts (cross_tool_insights, integrations_list, clarify)
 * also have dedicated specs covering richer interactions; the matrix
 * intentionally overlaps so a broken renderer is caught here even
 * if the dedicated spec is later split into a different suite.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

interface PromptCase {
  /** The prompt the user types into the composer. */
  prompt: string;
  /** Widget kind returned by the stubbed assistant. */
  widgetKind: string;
  /** data-testid the renderer is expected to mount. */
  widgetTestId: string;
  /** Minimal widget spec the stubbed /api/assistant POST returns. */
  widget: Record<string, unknown>;
}

const NOW = new Date().toISOString();

const CASES: PromptCase[] = [
  {
    prompt: "show vercel deploys for wolfpack-auto",
    widgetKind: "vercel_deployments",
    widgetTestId: "vercel-deployments-widget",
    widget: {
      kind: "vercel_deployments",
      projectName: "wolfpack-auto",
      title: "wolfpack-auto · recent deployments",
      items: [
        {
          id: "d1",
          projectName: "wolfpack-auto",
          state: "READY",
          target: "production",
          url: "wolfpack-auto.vercel.app",
          commitMessage: "feat: x",
          branch: "main",
          commitSha: "abc",
          createdAt: NOW,
          readyAt: NOW,
          creator: "alice",
        },
      ],
    },
  },
  {
    prompt: "list integrations",
    widgetKind: "integrations_list",
    widgetTestId: "integrations-list-widget",
    widget: {
      kind: "integrations_list",
      title: "integrations available",
      items: [
        {
          id: "search:calendar",
          name: "Calendar",
          category: "scheduling",
          surface: "search+widget",
          sampleQuery: "what is on my calendar today",
        },
      ],
    },
  },
  {
    prompt: "what is on my calendar today",
    widgetKind: "calendar",
    widgetTestId: "calendar-widget",
    widget: {
      kind: "calendar",
      month: NOW.slice(0, 7) + "-01",
      rangeStart: NOW,
      rangeEnd: NOW,
      events: [],
    },
  },
  {
    prompt: "show open pull requests",
    widgetKind: "github_items",
    widgetTestId: "github-items-widget",
    widget: {
      kind: "github_items",
      itemKind: "pull_request",
      title: "Open pull requests",
      items: [
        {
          id: "1",
          kind: "pull_request",
          number: 1,
          title: "feat",
          state: "open",
          draft: false,
          user: "alice",
          repo: "wolfpack-apex",
          url: "https://github.com/x/x/pull/1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
  },
  {
    prompt: "give me insights",
    widgetKind: "cross_tool_insights",
    widgetTestId: "cross-tool-insights-widget",
    widget: {
      kind: "cross_tool_insights",
      title: "1 cross-tool insight",
      lookbackDays: 30,
      items: [
        {
          id: "team_momentum_brief:today",
          generator: "team_momentum_brief",
          severity: "low",
          signalStrength: 30,
          title: "This week: 4 PRs merged",
          detail: null,
          action: null,
          sources: ["github", "vercel"],
        },
      ],
      generatorOutcomes: [],
    },
  },
  {
    prompt: "what should I know",
    widgetKind: "cross_tool_insights",
    widgetTestId: "cross-tool-insights-widget",
    widget: {
      kind: "cross_tool_insights",
      title: "No cross-tool insights right now",
      lookbackDays: 30,
      items: [],
      generatorOutcomes: [],
    },
  },
  {
    prompt: "show recent emails",
    widgetKind: "email_thread",
    widgetTestId: "email-thread-widget",
    widget: {
      kind: "email_thread",
      title: "Recent inbox",
      messages: [
        {
          id: "em1",
          subject: "hi",
          from: "Alicia",
          fromEmail: "alicia@thewolfpack.agency",
          receivedAt: NOW,
          preview: "hello",
          isRead: false,
          importance: "normal",
        },
      ],
    },
  },
  {
    prompt: "weather in boston",
    widgetKind: "weather",
    widgetTestId: "weather-widget",
    widget: {
      kind: "weather",
      location: "Boston, Massachusetts, US",
      temperatureC: 18,
      temperatureF: 64,
      condition: "Partly cloudy",
      highC: 22,
      lowC: 12,
      humidity: 55,
      windMph: 6,
    },
  },
  {
    prompt: "headlines",
    widgetKind: "headlines",
    widgetTestId: "headlines-widget",
    widget: {
      kind: "headlines",
      title: "Top headlines",
      items: [
        {
          title: "Test headline",
          link: "https://example.com/1",
          published: NOW,
          source: "Example",
        },
      ],
    },
  },
];

test.describe("Assistant prompts coverage matrix", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, {
      id: "u-cov",
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
        body: JSON.stringify({ conversationId: "c-cov", messages: [] }),
      });
    });
  });

  for (const c of CASES) {
    test(`prompt "${c.prompt}" renders ${c.widgetKind} widget`, async ({
      page,
    }) => {
      await page.route("**/api/assistant", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              response: `OK ${c.widgetKind}`,
              source: "tool",
              tokensUsed: 0,
              conversationId: "c-cov",
              messageId: `m-${c.widgetKind}`,
              workflowId: `wf-${c.widgetKind}`,
              widget: c.widget,
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

      await page.goto(`${target.baseUrl}/assistant`, {
        waitUntil: "domcontentloaded",
      });
      const welcomeClose = page.getByRole("button", { name: /close/i });
      if (await welcomeClose.isVisible().catch(() => false))
        await welcomeClose.click();

      const composer = page.getByTestId("assistant-composer-input");
      await composer.fill(c.prompt);
      await composer.press("Enter");

      await expect(page.getByTestId(c.widgetTestId)).toBeVisible({
        timeout: 10_000,
      });
    });
  }

  /* Sidebar-hide E2E (gap-close from the 2026-05-24 sidebar-hide
   * commit). Folded into this matrix file since it's a structural
   * /assistant-page invariant; a dedicated spec file would be one
   * test for one assertion. */
  test("conversations sidebar is HIDDEN by default on /assistant", async ({
    page,
  }) => {
    await page.route("**/api/assistant", async (route) => {
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

    // Composer must still be present (sanity).
    await expect(
      page.getByTestId("assistant-composer-input"),
    ).toBeVisible();
    // The sidebar element must not be in the DOM.
    await expect(
      page.getByTestId("conversations-sidebar"),
    ).toHaveCount(0);
  });
});
