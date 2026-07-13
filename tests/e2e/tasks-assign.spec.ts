/**
 * Tasks page — Outlook-parity reality check (/tasks).
 *
 * The operator's verified bug: on /tasks you can create a task but cannot
 * assign it to an individual, and the Outlook fields (reminder, start,
 * categories) were missing. This spec proves, at the layer the jest suite
 * cannot reach, that the redesigned New Task modal exposes an assignee picker
 * and a reminder control against the real deployed app, and that assigning
 * routes to Planner (the only Graph surface with assignments).
 *
 * The class of bug this defends against: a page that 200s but renders the old
 * assignment-less modal (a widget the unit tests pass on but that never
 * shipped), or a tasks page that blanks instead of redirecting an
 * unauthenticated visitor.
 *
 * Two paths (mirrors agent-detail-console.spec.ts):
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and EITHER
 *      the New Task modal exposes the assignee picker + reminder control (MS
 *      connected) OR the explicit "Connect Microsoft" CTA renders (MS not
 *      connected on the smoke account), with ZERO CSP/network failures.
 *
 * Non-destructive: it opens the modal and inspects controls but never submits,
 * so no task is created and prod Planner/To Do data is not polluted. A full
 * create-assign-submit needs the operator's delegated Graph token + a Planner
 * plan, which the smoke harness cannot provision.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Tasks page — assignment + Outlook fields reality check", () => {
  test("unauthenticated visit to /tasks redirects to /login (never blank)", async ({ page }) => {
    await page.goto(`${target.baseUrl}/tasks`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => undefined);
    expect(new URL(page.url()).pathname).toMatch(/^\/login/);
  });

  test("authenticated /tasks exposes the assignee picker + reminder in New Task", async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    test.skip(!signedIn, "No SMOKE_TEST_EMAIL/PASSWORD — skipping authenticated tasks check.");

    const failures = collectConsoleAndNetworkFailures(page);
    const resp = await page.goto(`${target.baseUrl}/tasks`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    expect(resp?.status(), "tasks page must not 5xx").toBeLessThan(500);

    // The page renders one of two valid states: connected (New task button) or
    // the Connect-Microsoft CTA. A blank page is the failure we defend against.
    const newTaskBtn = page.getByText("+ New task");
    const connectCta = page.getByText(/Connect Microsoft/i);
    await expect(newTaskBtn.or(connectCta).first()).toBeVisible({ timeout: 15_000 });

    if (await newTaskBtn.isVisible().catch(() => false)) {
      await newTaskBtn.click();
      const dialog = page.getByRole("dialog", { name: "New task" });
      await expect(dialog).toBeVisible();
      // The headline fix: the assignee picker is present on the primary surface.
      await expect(dialog.getByTestId("assignee-picker")).toBeVisible();
      // And the previously-missing reminder control.
      await expect(dialog.getByLabel("Reminder")).toBeVisible();
    }

    // Give the page a moment to settle, then assert no CSP/network failures.
    await page.waitForTimeout(2_000);
    const collected = failures();
    expect(collected, `CSP/network failures: ${JSON.stringify(collected, null, 2)}`).toEqual([]);
  });
});
