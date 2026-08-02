/**
 * The model router page, driven with a known payload and checked for CORRECTNESS.
 *
 * WHY A SECOND ROUTER SPEC
 *
 * ai-router.spec.ts is a reality check: it signs in and asserts the page loads
 * against real configuration without errors. That proves the page is wired. It
 * cannot prove the page is RIGHT, because the real data is whatever production
 * happens to hold, so there is nothing to compare the rendered numbers against.
 *
 * This one supplies the data. Every API response is intercepted with a payload
 * whose correct rendering is known in advance, so the assertions are about
 * arithmetic and wording rather than presence. It needs no credentials, so it
 * runs on every deploy rather than skipping when secrets are absent.
 *
 * WHAT IT IS ACTUALLY GUARDING
 *
 * This page quotes money. The failure that matters is not a blank panel, it is
 * a plausible wrong number: a total that silently excluded half the calls, a
 * cost shown as billed, a 0% that reads as "we never use the cheap model" when
 * the truth is "nothing has run". Each of those is asserted here because each
 * would be believed.
 */
import { test, expect, type Route } from "@playwright/test";

const PROD_URL = process.env.PROD_URL?.replace(/\/$/, "");
const BASE = PROD_URL || "http://localhost:3000";

/** A payload whose correct rendering is known: 12 decisions, 9 of them small
 *  tier (75%), $0.0431 estimated, 2 with no estimate, 1 fallback. */
const INSIGHTS = {
  days: 30,
  totalDecisions: 12,
  estimatedCostUsd: 0.0431,
  decisionsWithoutEstimate: 2,
  usage: [
    { modelId: "gpt-4o-mini", provider: "azure", tier: "small", decisions: 9, estimated: 8, estimatedCostUsd: 0.0121, fallbacks: 0 },
    { modelId: "gpt-4o", provider: "azure", tier: "large", decisions: 3, estimated: 2, estimatedCostUsd: 0.031, fallbacks: 1 },
  ],
  reasons: [
    { reason: "cheapest_at_tier", count: 9, description: "the cheapest model that met the requirement" },
    { reason: "agent_pin", count: 3, description: "an agent insisted on a specific model" },
  ],
  fallbacks: 1,
  models: [
    { modelId: "gpt-4o-mini", provider: "azure", tier: "small", contextWindow: 128000, inputPricePer1kUsd: 0.00015, outputPricePer1kUsd: 0.0006, available: true, blockedBy: null },
    { modelId: "o1-preview", provider: "openai", tier: "reasoning", contextWindow: 128000, inputPricePer1kUsd: 0.015, outputPricePer1kUsd: 0.06, available: false, blockedBy: "OPENAI_API_KEY is not set" },
  ],
  smallTierShare: 0.75,
  headline: "12 routing decisions, 75% served by the cheapest tier, 1 fell back because a preferred model was unavailable, 2 carried no cost estimate, so the total below understates the true figure.",
};

/** Sign-in is stubbed rather than performed: the page's auth check reads
 *  localStorage, and every API it calls is intercepted, so no real session is
 *  involved and no credentials are needed. */
async function openRouter(page: import("@playwright/test").Page, body: unknown) {
  await page.addInitScript(() => {
    localStorage.setItem("instinct_token", "e2e-stub");
    localStorage.setItem(
      "instinct_user",
      JSON.stringify({ id: "u-e2e", role: "cto", name: "E2E", workspaceId: "default" }),
    );
  });
  // ORDER MATTERS. Playwright tries the most recently registered handler
  // first, so the catch-all is registered BEFORE the specific one. Registered
  // the other way round it shadows the payload entirely and every assertion
  // fails against an empty body — which is exactly what happened, and the only
  // tests that passed were the two expecting the unreadable state.
  await page.route(/\/api\//, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route(/\/api\/admin\/ai-router/, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${BASE}/admin/ai-router`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Model router" })).toBeVisible({ timeout: 15_000 });
}

test.describe("model router page reports the truth about cost", () => {
  test("renders the counts it was given, without rearranging them", async ({ page }) => {
    await openRouter(page, INSIGHTS);
    await expect(page.getByTestId("router-metric-decisions")).toContainText("12");
    await expect(page.getByTestId("router-metric-cheap")).toContainText("75%");
    await expect(page.getByTestId("router-metric-fallbacks")).toContainText("1");
  });

  test("labels the cost as estimated and not billed", async ({ page }) => {
    // This page quotes money. Someone will reconcile it against an invoice.
    await openRouter(page, INSIGHTS);
    const cost = page.getByTestId("router-metric-cost");
    await expect(cost).toContainText("$0.04");
    await expect(cost).toContainText(/estimated/i);
    await expect(cost).toContainText(/not billed/i);
  });

  test("says out loud that the total understates the real figure", async ({ page }) => {
    // Two of twelve decisions carried no estimate. Without this line the $0.04
    // reads as the whole story.
    await openRouter(page, INSIGHTS);
    await expect(page.getByTestId("router-estimate-caveat")).toContainText(/understates the real total/i);
  });

  test("drops the caveat when every decision was estimated", async ({ page }) => {
    await openRouter(page, { ...INSIGHTS, decisionsWithoutEstimate: 0 });
    await expect(page.getByTestId("router-headline")).toBeVisible();
    await expect(page.getByTestId("router-estimate-caveat")).toHaveCount(0);
  });

  test("shows a sub-cent estimate at a precision that is not zero", async ({ page }) => {
    // $0.00 for real spend reads as free, which is a different claim entirely.
    await openRouter(page, { ...INSIGHTS, estimatedCostUsd: 0.0012 });
    await expect(page.getByTestId("router-metric-cost")).toContainText("$0.0012");
  });

  test("shows n/a rather than 0% when nothing has been routed", async ({ page }) => {
    // 0% reads as "we never use the cheap model", which is a finding. Nothing
    // recorded is not a finding.
    await openRouter(page, { ...INSIGHTS, totalDecisions: 0, smallTierShare: null, usage: [], reasons: [] });
    await expect(page.getByTestId("router-metric-cheap")).toContainText("n/a");
  });
});

test.describe("model router page reports the truth about configuration", () => {
  test("names the variable that is missing, not just 'unavailable'", async ({ page }) => {
    // "Unavailable" sends someone digging. The variable name is the fix.
    await openRouter(page, INSIGHTS);
    const models = page.getByTestId("router-models");
    await expect(models).toContainText("OPENAI_API_KEY is not set");
    await expect(models).toContainText("Not configured");
  });

  test("shows which models were used and why they were chosen", async ({ page }) => {
    await openRouter(page, INSIGHTS);
    await expect(page.getByTestId("router-usage")).toContainText("gpt-4o-mini");
    await expect(page.getByTestId("router-usage")).toContainText("without an estimate");
    await expect(page.getByTestId("router-reasons")).toContainText("the cheapest model that met the requirement");
  });

  test("says availability is not editable here, and why", async ({ page }) => {
    // A form post that changes which models serve every AI call belongs in a
    // deployment with a review.
    await openRouter(page, INSIGHTS);
    await expect(page.getByText(/belongs in a deployment with a review/i)).toBeVisible();
  });
});

test.describe("model router page does not pretend when it cannot read", () => {
  test("does not present an unreadable router as an idle one", async ({ page }) => {
    await openRouter(page, { nonsense: true });
    await expect(page.getByTestId("router-unavailable")).toContainText(
      /not the same as no activity having happened/i,
    );
  });

  test("survives a payload missing its arrays instead of blanking the page", async ({ page }) => {
    // Version skew during a deploy: an old client can meet a new server.
    await openRouter(page, { days: 30, usage: null, models: undefined });
    await expect(page.getByRole("heading", { name: "Model router" })).toBeVisible();
    await expect(page.getByTestId("router-unavailable")).toBeVisible();
  });
});
