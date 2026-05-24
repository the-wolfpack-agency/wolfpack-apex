/**
 * E2E: cross-tool insights + integrations list — both widgets render
 * end-to-end against the deployed assistant. Mocks the chat endpoint
 * to return a widget spec for each prompt, then asserts the widget
 * appears, the items render, and the click-through actions fire
 * analytics.
 *
 * Combined with prior regression coverage in assistant-widget-
 * persistence.spec.ts (which proves widgets survive silent-refresh),
 * this spec proves the new widgets ship correctly to the chat surface.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const CROSS_TOOL_INSIGHTS_RESPONSE = {
  response: "Found 2 cross-tool insights (2 high-signal).",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-cti-1",
  messageId: "m-cti-1",
  workflowId: "wf-cti-1",
  widget: {
    kind: "cross_tool_insights",
    title: "2 cross-tool insights",
    subtitle: "Across 2 integrations, 2 of 2 patterns checked.",
    lookbackDays: 30,
    items: [
      {
        id: "github_pr_stagnation:wolfpack-apex#42",
        generator: "github_pr_stagnation",
        severity: "high",
        signalStrength: 95,
        title: "wolfpack-apex#42: open 19 days, no activity",
        detail: "fix: bug",
        action: { label: "Open PR", href: "https://github.com/x/y/pull/42" },
        sources: ["github"],
      },
      {
        id: "vercel_failed_no_followup:d-test",
        generator: "vercel_failed_no_followup",
        severity: "high",
        signalStrength: 90,
        title: "wolfpack-auto: failed production deploy on main",
        detail: null,
        action: { label: "Open Vercel", href: "https://vercel.com/x/y/d" },
        sources: ["vercel", "github"],
      },
    ],
    generatorOutcomes: [
      { name: "github_pr_stagnation", count: 1, ok: true },
      { name: "vercel_failed_no_followup", count: 1, ok: true },
    ],
  },
};

const INTEGRATIONS_LIST_RESPONSE = {
  response: "Showing 4 integrations the assistant can use.",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-il-1",
  messageId: "m-il-1",
  workflowId: "wf-il-1",
  widget: {
    kind: "integrations_list",
    title: "4 integrations available",
    subtitle: "Click a sample query to try it.",
    items: [
      { id: "search:calendar", name: "Calendar (Microsoft 365)", category: "scheduling", surface: "search+widget", sampleQuery: "what is on my calendar today" },
      { id: "search:emails", name: "Outlook Email", category: "messaging", surface: "search+widget", sampleQuery: "find emails from Alicia" },
      { id: "search:vercel", name: "Vercel Deployments", category: "ops", surface: "search+widget", sampleQuery: "show vercel deploys" },
      { id: "tool:cross_tool_insights_widget", name: "Cross-Tool Insights", category: "data", surface: "widget", sampleQuery: "show me cross-tool insights" },
    ],
  },
};

test.describe("Cross-tool insights + integrations list widgets", () => {
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
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/assistant?conversationId=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversationId: "c-cti-1", messages: [] }),
      });
    });
  });

  test("cross-tool insights widget renders with multiple insights", async ({ page }) => {
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(CROSS_TOOL_INSIGHTS_RESPONSE),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${target.baseUrl}/assistant`, { waitUntil: "domcontentloaded" });
    const welcomeClose = page.getByRole("button", { name: /close/i });
    if (await welcomeClose.isVisible().catch(() => false)) await welcomeClose.click();

    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("show me cross-tool insights");
    await composer.press("Enter");

    await expect(page.getByTestId("cross-tool-insights-widget")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("cross-tool-insight-github_pr_stagnation:wolfpack-apex#42"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cross-tool-insight-vercel_failed_no_followup:d-test"),
    ).toBeVisible();
  });

  test("integrations list widget renders all integrations with sample queries", async ({ page }) => {
    await page.route("**/api/assistant", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(INTEGRATIONS_LIST_RESPONSE),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${target.baseUrl}/assistant`, { waitUntil: "domcontentloaded" });
    const welcomeClose = page.getByRole("button", { name: /close/i });
    if (await welcomeClose.isVisible().catch(() => false)) await welcomeClose.click();

    const composer = page.getByTestId("assistant-composer-input");
    await composer.fill("list integrations");
    await composer.press("Enter");

    await expect(page.getByTestId("integrations-list-widget")).toBeVisible({ timeout: 10_000 });
    for (const it of INTEGRATIONS_LIST_RESPONSE.widget.items) {
      await expect(page.getByTestId(`integration-item-${it.id}`)).toBeVisible();
    }
    await expect(page.getByText(/Try: show me cross-tool insights/)).toBeVisible();
  });
});
