/**
 * Tasks "New task" E2E — creating a task must NOT require picking a list.
 *
 * Reproduces the reported dead-end: a user whose task-list cache is EMPTY opened
 * "New task" and the list dropdown had nothing selectable, so Create stayed
 * disabled. The fix makes the list optional (server defaults to the user's
 * default To Do list), so Create works with just a title.
 *
 * Drives the real page bundle with a stubbed session and intercepted APIs, so
 * the test is deterministic and non-destructive. The lists endpoint returns []
 * on purpose to reproduce the exact empty-cache condition.
 */

import { test, expect, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

async function stubTasksApis(page: import("@playwright/test").Page) {
  await page.route(/\/api\/tasks/, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/tasks/lists")) return json({ lists: [] }); // empty cache: the bug condition
    if (path.endsWith("/tasks")) {
      if (req.method() === "POST") {
        return json(
          {
            task: {
              id: "t-e2e",
              msTaskId: "ms-e2e",
              listId: "default",
              title: "Coaching Call Reschedules",
              body: null,
              status: "notStarted",
              importance: "normal",
              dueAt: null,
              completedAt: null,
            },
          },
          201,
        );
      }
      return json({ tasks: [] });
    }
    return json({});
  });

  await page.route(/\/api\/integrations\/status/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ microsoft: { connected: true } }),
    }),
  );
}

test.describe("Tasks — New task", () => {
  test("creates a task with just a title, even with zero cached lists (no forced list pick)", async ({
    page,
  }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    await stubInstinctSession(page, { role: "admin" });
    await stubTasksApis(page);

    await page.goto(`${target.baseUrl}/tasks`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    await page.getByRole("button", { name: /new task/i }).click();

    const title = page.getByPlaceholder("Task title");
    await expect(title).toBeVisible({ timeout: 15_000 });

    const create = page.getByTestId("new-task-create");
    await expect(create, "disabled with no title").toBeDisabled();

    await title.fill("Coaching Call Reschedules");
    // The fix: a title alone enables Create; no list has to be picked, and the
    // empty list dropdown no longer blocks creation.
    await expect(create, "a title alone enables create").toBeEnabled();

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith("/api/tasks") && r.method() === "POST"),
      create.click(),
    ]);
    const body = JSON.parse(request.postData() || "{}");
    expect(body.title).toBe("Coaching Call Reschedules");
    // No specific list is sent; the server resolves the default To Do list.
    expect(body.listId ?? "").toBe("");

    const consoleFailures = snapshot().filter((f) => f.kind === "console");
    expect(consoleFailures, `console/CSP failures: ${JSON.stringify(consoleFailures, null, 2)}`).toEqual([]);
  });
});
