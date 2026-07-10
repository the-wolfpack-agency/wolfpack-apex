/**
 * Agent model-regression watch E2E — the model-eval panel on /admin/agents.
 *
 * Proves the founding-pain surface renders in a real browser: when an agent's
 * newest model does materially worse at its task than the model it used before,
 * the agents page shows a "Model regression watch" panel that lists the agent,
 * both models with their success rates, and the point drop. Drives the real page
 * bundle with a stubbed session and intercepted APIs, so it is deterministic and
 * non-destructive.
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const AGENT_ID = "agt-e2e-1";
const ACTIVE_AGENT = {
  id: AGENT_ID,
  workspaceId: "default",
  name: "Scout",
  role: "member",
  state: "active",
  ownerUserId: "u-test",
  boundConnections: [],
  scanStatus: "complete",
  createdBy: "u-test",
  createdAt: "2026-07-01T00:00:00Z",
  activatedAt: "2026-07-01T00:00:00Z",
  lastSeenAt: null,
  revokedAt: null,
};

const REGRESSED_STANDING = {
  agentId: AGENT_ID,
  agentName: "Scout",
  verdict: "regressed",
  candidateModel: "gpt-new",
  baselineModel: "gpt-old",
  candidateSuccessRate: 0.5,
  baselineSuccessRate: 0.9,
  delta: -0.4,
  candidateSamples: 20,
  baselineSamples: 20,
};

async function stubApis(page: import("@playwright/test").Page) {
  await page.route(/\/api\/admin\/agents/, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/agents/model-regressions")) {
      return json({ ok: true, standings: [REGRESSED_STANDING], regressions: [] });
    }
    if (path.endsWith("/agents")) return json({ agents: [ACTIVE_AGENT] }); // roster
    // Defensive default so no agent subresource 401s to the server.
    return json({ items: [], approvals: [], entries: [], tasks: [], events: [] });
  });

  // The sibling release-gate panel on the same page: keep it from hitting the
  // network so the console/network assertion stays clean.
  await page.route(/\/api\/admin\/deployment\/release-gate/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        gate: { productionBranch: "main", blocking: [], checkedAt: "2026-07-10T00:00:00Z" },
      }),
    }),
  );
}

test.describe("Agents — model regression watch", () => {
  test("unauthenticated visit redirects to /login (never a blank page)", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/agents`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);
    expect(page.url(), "unauth agents page lands on /login").toContain("/login");
  });

  test("authenticated: the panel lists a regressed agent with its models and delta", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    await stubInstinctSession(page, { role: "admin" });
    await stubApis(page);

    await page.goto(`${target.baseUrl}/admin/agents`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    const panel = page.getByTestId("agents-model-regression");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`agents-model-regression-agent-${AGENT_ID}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Scout");
    await expect(row).toContainText("gpt-old (90%)");
    await expect(row).toContainText("gpt-new (50%)");
    await expect(page.getByTestId(`agents-model-regression-delta-${AGENT_ID}`)).toContainText("-40 pts");
    await expect(page.getByTestId("agents-model-regression-regressed-count")).toContainText("1");

    const consoleFailures = snapshot().filter((f) => f.kind === "console");
    expect(consoleFailures, `console/CSP failures: ${JSON.stringify(consoleFailures, null, 2)}`).toEqual([]);
  });
});
