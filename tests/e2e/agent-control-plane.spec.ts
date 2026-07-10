/**
 * Agent control plane E2E (/admin/agents/[id] task template).
 *
 * Proves, through the real browser against the built page, that the redesigned
 * "Give this agent a job" surface functions as intended:
 *   1. Unauthenticated visit redirects to /login (never a blank form). Always
 *      runs; needs no creds.
 *   2. Authenticated (stubbed session + intercepted agent APIs): the task
 *      TEMPLATE renders (Objective, Success criteria, Context, Target), the
 *      submit is gated until the two REQUIRED fields are filled, and submitting
 *      POSTs the structured template (objective + successCriteria + source:
 *      detail_page) to the governed task API, after which the form clears on the
 *      terminal 201. No CSP violations or JS crashes over the flow.
 *
 * The agent APIs are intercepted so the test is fast, deterministic, and
 * non-destructive (it never creates a real task or runs a real agent). The page
 * bundle, the form wiring, and the template contract are exercised for real.
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const AGENT_ID = "e2e-control-plane-agent";
const PATH = `/admin/agents/${AGENT_ID}`;

const ACTIVE_AGENT = {
  id: AGENT_ID,
  workspaceId: "default",
  name: "E2E Control-Plane Agent",
  role: "ops",
  ownerUserId: "u-test",
  state: "active",
  identityProvider: "local",
  externalSubject: null,
  scanStatus: "complete",
  description: null,
  createdBy: "u-test",
  createdAt: "2026-07-01T00:00:00Z",
  activatedAt: "2026-07-01T00:00:00Z",
  lastSeenAt: null,
  revokedAt: null,
};

async function stubAgentApis(page: import("@playwright/test").Page) {
  // Regex route (unambiguous vs a glob) so every /api/admin/agents* call is
  // intercepted: the roster, the agent GET, its subresources, and the sibling
  // /approvals endpoint.
  await page.route(/\/api\/admin\/agents/, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    const segs = path.split("/").filter(Boolean); // [api, admin, agents, ...]
    const last = segs[segs.length - 1];

    if (last === "agents") return json({ agents: [ACTIVE_AGENT] }); // roster
    if (last === AGENT_ID) return json({ agent: ACTIVE_AGENT }); // agent GET

    const sub = last;

    if (sub === "tasks") {
      if (method === "POST") {
        const body = JSON.parse(req.postData() || "{}");
        return json(
          {
            task: {
              id: "t-e2e-1",
              agentId: AGENT_ID,
              workspaceId: "default",
              assignedBy: "u-test",
              goal: body.objective ?? body.goal ?? "",
              successCriteria: body.successCriteria ?? null,
              context: body.context ?? null,
              targetConnectionId: body.targetConnectionId ?? null,
              source: body.source ?? null,
              status: "succeeded",
              steps: [
                { index: 0, instruction: body.objective ?? "", tool: "search", outcome: "ran", detail: "ok" },
              ],
              resultSummary: "Completed by the E2E control plane.",
              createdAt: "2026-07-10T00:00:00Z",
              startedAt: "2026-07-10T00:00:00Z",
              finishedAt: "2026-07-10T00:00:01Z",
            },
          },
          201,
        );
      }
      return json({ tasks: [] });
    }

    if (sub === "connections")
      return json({
        bound: [{ connectorName: "Salesforce", baseUrl: "https://example.test", authType: "oauth-password" }],
        available: [],
      });
    if (sub === "scan") return json({ error: "no_scan" }, 404);
    if (sub === "drift") return json({ baseline: null, events: [], latest: null });
    if (sub === "log") return json({ entries: [] });
    if (sub === "backup") return json({ backupAgentId: null });
    if (sub === "approvals") return json({ approvals: [], history: [], items: [], pending: [] });

    // Defensive default for any other subresource so nothing 401s to the server.
    return json({ items: [], approvals: [], writes: [], entries: [], tasks: [], events: [] });
  });
}

test.describe("Agent control plane — task template", () => {
  test("unauthenticated visit redirects to /login (never a blank form)", async ({ page }) => {
    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);
    expect(page.url(), "unauth agent detail lands on /login, not a blank form").toContain("/login");
  });

  test("authenticated: template renders, gates on required fields, and submits the structured template", async ({
    page,
  }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    await stubInstinctSession(page, { role: "admin" });
    await stubAgentApis(page);

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    // The form lives in the Work tab; default tab is Overview.
    await page.getByTestId("agent-tab-work").click();

    const objective = page.getByTestId("agent-task-goal");
    await expect(objective).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agent-task-success")).toBeVisible();
    await expect(page.getByTestId("agent-task-context")).toBeVisible();
    // Target dropdown only appears when the agent has a bound connection (stubbed).
    await expect(page.getByTestId("agent-task-target")).toBeVisible();

    const submit = page.getByTestId("agent-task-submit");
    await expect(submit).toBeDisabled();

    await objective.fill("Reconcile June vendor invoices");
    await expect(submit, "objective alone is not enough").toBeDisabled();

    await page.getByTestId("agent-task-success").fill("All 31 invoices matched or flagged");
    await expect(submit, "objective + success criteria enables run").toBeEnabled();

    // Capture the outbound POST and assert the structured template contract.
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes(`/api/admin/agents/${AGENT_ID}/tasks`) && r.method() === "POST",
      ),
      submit.click(),
    ]);
    const body = JSON.parse(request.postData() || "{}");
    expect(body).toMatchObject({
      objective: "Reconcile June vendor invoices",
      successCriteria: "All 31 invoices matched or flagged",
      source: "detail_page",
    });

    // On the terminal 201 the form clears (deterministic success signal).
    await expect(objective).toHaveValue("", { timeout: 15_000 });

    // No CSP violations and no JS crashes over the whole flow.
    const consoleFailures = snapshot().filter((f) => f.kind === "console");
    expect(consoleFailures, `console/CSP failures: ${JSON.stringify(consoleFailures, null, 2)}`).toEqual([]);
  });
});
