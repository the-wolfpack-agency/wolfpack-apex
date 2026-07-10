/**
 * Agent screenshot thumbnail E2E.
 *
 * Proves the payoff of the screenshot capability: when an agent run has a step
 * that captured a screenshot (step.imageUrl), the agent detail page renders it
 * as a real thumbnail from the workspace-scoped serving route. Drives the real
 * page bundle with a stubbed session + intercepted APIs (deterministic, no
 * browser capture, no DB).
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const AGENT_ID = "e2e-screenshot-agent";
const SHOT_URL = "/api/tools/screenshot/e2e-shot-1";

// 1x1 transparent PNG.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const ACTIVE_AGENT = {
  id: AGENT_ID, workspaceId: "default", name: "Screenshot Agent", role: "ops",
  ownerUserId: "u-test", state: "active", identityProvider: "local", externalSubject: null,
  scanStatus: "complete", description: null, createdBy: "u-test", createdAt: "2026-07-01T00:00:00Z",
  activatedAt: "2026-07-01T00:00:00Z", lastSeenAt: null, revokedAt: null,
};

const TASK_WITH_SHOT = {
  id: "task-ss", agentId: AGENT_ID, workspaceId: "default", assignedBy: "u-test",
  goal: "screenshot the deployed tasks page", successCriteria: null, context: null,
  targetConnectionId: null, source: "detail_page", status: "succeeded",
  steps: [
    {
      index: 0,
      instruction: "screenshot the deployed tasks page",
      tool: "op_capture_screenshot",
      outcome: "ran",
      detail: `Completed capture_screenshot: ${SHOT_URL}`,
      imageUrl: SHOT_URL,
    },
  ],
  resultSummary: "Captured the page.",
  createdAt: "2026-07-10T00:00:00Z", startedAt: "2026-07-10T00:00:00Z", finishedAt: "2026-07-10T00:00:02Z",
};

async function stubApis(page: import("@playwright/test").Page) {
  await page.route(/\/api\/admin\/agents/, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const j = (b: unknown, s = 200) =>
      route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    const segs = path.split("/").filter(Boolean);
    const last = segs[segs.length - 1];
    if (last === "agents") return j({ agents: [ACTIVE_AGENT] });
    if (last === AGENT_ID) return j({ agent: ACTIVE_AGENT });
    if (last === "tasks") return j({ tasks: [TASK_WITH_SHOT] });
    if (last === "connections") return j({ bound: [], available: [] });
    if (last === "scan") return j({ error: "no_scan" }, 404);
    if (last === "drift") return j({ baseline: null, events: [], latest: null });
    if (last === "log") return j({ entries: [] });
    if (last === "backup") return j({ backupAgentId: null });
    return j({ items: [], approvals: [], history: [], entries: [], tasks: [], events: [] });
  });
  // The workspace-scoped serving route returns the PNG bytes the thumbnail loads.
  await page.route("**/api/tools/screenshot/**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1x1 }),
  );
}

test("an agent run step renders its captured screenshot as a thumbnail", async ({ page }) => {
  const snapshot = collectConsoleAndNetworkFailures(page);
  await stubInstinctSession(page, { role: "admin" });
  await stubApis(page);

  await page.goto(`${target.baseUrl}/admin/agents/${AGENT_ID}`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  await page.getByTestId("agent-tab-work").click();
  // Expand the task to reveal its governed steps.
  await page.getByTestId("agent-task-toggle-task-ss").click({ timeout: 15_000 });

  const thumb = page.getByTestId("agent-task-task-ss-step-0-screenshot");
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  const img = thumb.locator("img");
  await expect(img).toHaveAttribute("src", SHOT_URL);
  // The image actually loaded (non-zero natural width), not a broken ref.
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  const consoleFailures = snapshot().filter((f) => f.kind === "console");
  expect(consoleFailures, JSON.stringify(consoleFailures, null, 2)).toEqual([]);
});
