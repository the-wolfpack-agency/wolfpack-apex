/**
 * E2E: the pilot status widget, driven through the real chat UI.
 *
 * WHAT THIS IS PROVING, and why it is not the same as the unit tests. The
 * component test renders the widget directly. This types a sentence a client
 * would say into the deployed composer and asserts what comes back on screen,
 * which is the only layer that catches a tool emitting a widget kind the chat
 * surface does not know how to render. That bug shipped here before: the
 * TimeLogWidget emitted specs for two months while the dispatcher silently
 * dropped every one, and nothing failed.
 *
 * THE SECOND CASE IS THE IMPORTANT ONE. A pilot status answer is read by a
 * client, and the failure that matters is not a crash, it is a confident
 * "nothing is blocked" drawn over a task store that never answered. So the
 * partial-view test asserts the pixels a client would actually read: the word
 * "unknown" where a count would be, the row still present, and a headline that
 * declines to say "on track".
 */

import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession } from "./helpers/smoke-helpers";
import { askAssistant } from "./helpers/assistant-composer";

const target = resolveSmokeTarget();

/** All three systems answered, and something is genuinely blocking. */
const BLOCKED_RESPONSE = {
  response:
    "Blocked: 4 open items (2 overdue), 3 documents in the last 14 days, next checkpoint Thu, Aug 28, 10:00 AM.",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-ps-1",
  messageId: "m-ps-1",
  workflowId: "wf-ps-1",
  widget: {
    kind: "pilot_status",
    title: "Blocked",
    subtitle: "Joined from calendar, Brain and tasks over the last 14 days.",
    readiness: "blocked",
    readinessLabel: "Blocked",
    windowDays: 14,
    takenAt: "2026-08-26T12:00:00.000Z",
    sources: [
      { source: "calendar", state: "ok", count: 3, detail: "3 meetings in the next 14 days" },
      { source: "documents", state: "ok", count: 3, detail: "3 landed in the Brain in the last 14 days" },
      { source: "tasks", state: "ok", count: 4, detail: "4 open, 6 closed in the last 14 days" },
    ],
    signals: [
      {
        id: "overdue-before-checkpoint",
        tone: "blocker",
        title: "2 overdue tasks before Pilot review",
        detail:
          "Pilot review is Thu, Aug 28 at 10:00 AM and 2 items are already past due. The date arrives whether the work does or not.",
        sources: ["calendar", "tasks"],
      },
      {
        id: "work-remaining",
        tone: "watch",
        title: "4 open items left to do",
        detail: "6 closed in the last 14 days.",
        sources: ["tasks"],
      },
    ],
    nextCheckpoint: { subject: "Pilot review", when: "Thu, Aug 28, 10:00 AM" },
  },
};

/** One system down. The reading is partial and has to say so. */
const PARTIAL_RESPONSE = {
  response:
    "I can only see calendar and documents right now (tasks unavailable), which is not enough to say how the pilot is going without guessing at the rest.",
  source: "tool",
  tokensUsed: 0,
  conversationId: "c-ps-2",
  messageId: "m-ps-2",
  workflowId: "wf-ps-2",
  widget: {
    kind: "pilot_status",
    title: "Not enough signal",
    subtitle:
      "Joined from 2 of 3 systems over the last 14 days. tasks unavailable, so counts from it are unknown rather than zero.",
    readiness: "unknown",
    readinessLabel: "Not enough signal",
    windowDays: 14,
    takenAt: "2026-08-26T12:00:00.000Z",
    sources: [
      { source: "calendar", state: "ok", count: 2, detail: "2 meetings in the next 14 days" },
      { source: "documents", state: "ok", count: 0, detail: "0 landed in the Brain in the last 14 days" },
      { source: "tasks", state: "unavailable", count: null, detail: "The task store read failed: timeout" },
    ],
    signals: [
      {
        id: "checkpoint-without-material",
        tone: "watch",
        title: "Nothing new in the Brain before Pilot review",
        detail: "No document has landed in the last 14 days.",
        sources: ["calendar", "documents"],
      },
      {
        id: "dark-tasks",
        tone: "dark",
        title: "tasks could not be read",
        detail: "The task store read failed: timeout",
        sources: ["tasks"],
      },
    ],
    nextCheckpoint: { subject: "Pilot review", when: "Thu, Aug 28, 10:00 AM" },
  },
};

async function stubChat(page: import("@playwright/test").Page, body: unknown) {
  await page.route("**/api/assistant", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

async function ask(page: import("@playwright/test").Page, prompt: string) {
  await page.goto(`${target.baseUrl}/assistant`, { waitUntil: "domcontentloaded" });
  const welcomeClose = page.getByRole("button", { name: /close/i });
  if (await welcomeClose.isVisible().catch(() => false)) await welcomeClose.click();
  /* Drives the send BUTTON. A plain Enter in this composer inserts a newline
     and sends nothing, which is why every assistant spec in this suite was
     timing out on a widget it had never asked for. */
  await askAssistant(page, prompt);
}

test.describe("pilot status widget", () => {
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
    await page.route("**/api/assistant?conversationId=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversationId: "c-ps-1", messages: [] }),
      });
    });
    await page.route("**/api/analytics", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
  });

  test("'what's blocking the pilot' renders the cross-system answer", async ({ page }) => {
    await stubChat(page, BLOCKED_RESPONSE);
    await ask(page, "what's blocking the pilot");

    const widget = page.getByTestId("pilot-status-widget");
    await expect(widget).toBeVisible({ timeout: 15_000 });
    await expect(widget).toHaveAttribute("data-readiness", "blocked");
    await expect(page.getByTestId("pilot-status-headline")).toHaveText("Blocked");

    /* All three systems, each with its own count. */
    await expect(page.getByTestId("pilot-status-count-calendar")).toHaveText("3");
    await expect(page.getByTestId("pilot-status-count-documents")).toHaveText("3");
    await expect(page.getByTestId("pilot-status-count-tasks")).toHaveText("4");

    /* THE DEMO MOMENT: one row carrying two source badges, which is the fact
       neither the calendar nor the task list holds on its own. */
    const blocker = page.getByTestId("pilot-status-signal-overdue-before-checkpoint");
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText("2 overdue tasks before Pilot review");
    /* exact, because the row's TITLE also contains the word "tasks" and an
       inexact match resolves to two elements. */
    await expect(blocker.getByText("Calendar", { exact: true })).toBeVisible();
    await expect(blocker.getByText("Tasks", { exact: true })).toBeVisible();

    await expect(page.getByTestId("pilot-status-next-checkpoint")).toContainText("Pilot review");
  });

  test("a dead task store reads as unknown, never as zero", async ({ page }) => {
    await stubChat(page, PARTIAL_RESPONSE);
    await ask(page, "how is the pilot going");

    const widget = page.getByTestId("pilot-status-widget");
    await expect(widget).toBeVisible({ timeout: 15_000 });

    /* The count a client would read. */
    const tasksCount = page.getByTestId("pilot-status-count-tasks");
    await expect(tasksCount).toHaveText("unknown");
    await expect(tasksCount).not.toHaveText("0");

    /* The row survives rather than being filtered out of the picture. */
    await expect(page.getByTestId("pilot-status-source-tasks")).toHaveAttribute(
      "data-state",
      "unavailable",
    );
    await expect(page.getByTestId("pilot-status-state-tasks")).toHaveText("not read");

    /* A source that genuinely answered zero still shows zero. */
    await expect(page.getByTestId("pilot-status-count-documents")).toHaveText("0");

    /* And the headline declines to be optimiztic. */
    await expect(widget).toHaveAttribute("data-readiness", "unknown");
    await expect(page.getByTestId("pilot-status-headline")).toHaveText("Not enough signal");
    await expect(page.getByTestId("pilot-status-subtitle")).toContainText(
      "unknown rather than zero",
    );
    await expect(page.getByText("2/3 systems")).toBeVisible();
  });

  test("renders without a CSP refusal or an uncaught React error", async ({ page }) => {
    /* A widget can render and still be broken: a CSP refusal or a component
       throwing during render shows up here and nowhere else in this suite.
     *
     * SCOPED DELIBERATELY, to the two things this harness can actually prove.
     * It is NOT a blanket "no console errors" check, because the stubbed
     * session leaves the app's other API calls unauthenticated and they log
     * 401s that say nothing about this widget. A check that fails for a reason
     * unrelated to what it is guarding gets muted, and a muted check is the
     * kind of control this codebase has just spent a day removing. Real 401
     * blank-page coverage lives in the smoke probes, against a real session.
     */
    /* React's development build logs a CSP-shaped complaint about eval(),
       and its own message says "React will never use eval() in production
       mode". This spec targets PROD_URL in CI, which is a production build,
       so the line cannot appear there. Excluded by its exact wording rather
       than by loosening the pattern, so a genuine eval-related refusal in a
       production bundle would still be caught. */
    const REACT_DEV_EVAL = /React requires eval\(\) in development mode/i;

    const fatal: string[] = [];
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() !== "error") return;
      if (REACT_DEV_EVAL.test(text)) return;
      if (/Content.Security.Policy|Refused to/i.test(text)) fatal.push(`csp: ${text}`);
    });
    page.on("pageerror", (e) => fatal.push(`pageerror: ${e.message}`));

    await stubChat(page, BLOCKED_RESPONSE);
    await ask(page, "where do we stand");
    await expect(page.getByTestId("pilot-status-widget")).toBeVisible({ timeout: 15_000 });
    /* The signal rows are the part that renders a list; a throw in the map
       would leave the shell visible and the body empty. */
    await expect(page.getByTestId("pilot-status-signal-work-remaining")).toBeVisible();

    expect(fatal).toEqual([]);
  });
});
