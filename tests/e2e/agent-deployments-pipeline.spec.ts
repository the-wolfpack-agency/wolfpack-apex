/**
 * Agent deployment-pipeline E2E — the Deployments tab on agent detail.
 *
 * Proves the founding surface renders in a real browser: opening an agent's
 * Deployments tab shows the code changes it engaged with, each as a full
 * CI -> merge -> build -> promote -> verify -> health pipeline (the Stepper).
 * Drives the real page bundle with a stubbed session and intercepted APIs, so it
 * is deterministic and non-destructive.
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const AGENT_ID = "agt-e2e-dep";
const ACTIVE_AGENT = {
  id: AGENT_ID,
  workspaceId: "default",
  name: "Scout",
  role: "member",
  state: "active",
  ownerUserId: "u-test",
  identityProvider: "local",
  externalSubject: null,
  scanStatus: "complete",
  description: null,
  createdBy: "u-test",
  createdAt: "2026-07-01T00:00:00Z",
  activatedAt: "2026-07-01T00:00:00Z",
  lastSeenAt: null,
  revokedAt: null,
  connections: [],
};

const INFLIGHT_PIPELINE = {
  id: "pr-42",
  title: "Fix the blocking deploy",
  url: "https://gh/pr/42",
  author: "nick",
  commitSha: "s42",
  prNumber: 42,
  ageHours: 3,
  hasMigration: true,
  live: false,
  status: "failed",
  currentStage: "ci",
  stages: [
    { key: "ci", label: "CI checks", status: "failed", detail: "A required check is failing" },
    { key: "merge", label: "Merge", status: "pending", detail: "Awaiting a clean CI and approval" },
    { key: "build", label: "Build + migrate", status: "pending", detail: "Not merged yet (includes a DB migration)" },
    { key: "promote", label: "Promote", status: "pending", detail: "Not merged yet" },
    { key: "verify", label: "Prod verify", status: "pending", detail: "Not merged yet" },
    { key: "health", label: "Health", status: "pending", detail: "Not merged yet" },
  ],
};

async function stubAgentApis(page: import("@playwright/test").Page) {
  await page.route(/\/api\/admin\/agents/, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    const segs = path.split("/").filter(Boolean); // [api, admin, agents, ...]
    const last = segs[segs.length - 1];

    if (last === "agents") return json({ agents: [ACTIVE_AGENT] });
    if (last === AGENT_ID) return json({ agent: ACTIVE_AGENT });
    if (last === "deployments") {
      return json({
        ok: true,
        degraded: [],
        links: [
          { prNumber: 42, stateAtTriage: "checks_failing", triagedAt: "2026-07-10T00:00:00Z", pipeline: INFLIGHT_PIPELINE, resolved: false },
        ],
      });
    }
    if (last === "drift") return json({ baseline: null, events: [], latest: null });
    if (last === "log") return json({ entries: [] });
    if (last === "tasks") return json({ tasks: [] });
    if (last === "connections") return json({ bound: [], available: [] });
    if (last === "backup") return json({ backupAgentId: null });
    if (last === "scan") return json({ error: "no_scan" }, 404);
    if (last === "approvals") return json({ approvals: [], history: [], items: [], pending: [] });
    return json({ items: [], approvals: [], writes: [], entries: [], tasks: [], events: [] });
  });
}

test.describe("Agent detail — Deployments tab", () => {
  test("unauthenticated visit redirects to /login (never a blank page)", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/agents/${AGENT_ID}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);
    expect(page.url(), "unauth agent detail lands on /login").toContain("/login");
  });

  test("authenticated: the Deployments tab shows the change's full pipeline", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    await stubInstinctSession(page, { role: "admin" });
    await stubAgentApis(page);

    await page.goto(`${target.baseUrl}/admin/agents/${AGENT_ID}`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    await page.getByTestId("agent-tab-deployments").click();

    const row = page.getByTestId("agent-deployments-row-42");
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("#42 Fix the blocking deploy");
    await expect(row).toContainText("MIGRATION");
    // The full six-stage pipeline stepper rendered, CI failing.
    await expect(page.getByTestId("agent-deployments-row-42-stepper-step-health")).toBeVisible();
    await expect(page.getByTestId("agent-deployments-row-42-stepper-step-ci")).toHaveAttribute("data-status", "failed");

    const consoleFailures = snapshot().filter((f) => f.kind === "console");
    expect(consoleFailures, `console/CSP failures: ${JSON.stringify(consoleFailures, null, 2)}`).toEqual([]);
  });
});
