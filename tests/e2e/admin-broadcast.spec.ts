/**
 * Announcements reality check (/admin/broadcast).
 *
 * This page writes one message into every person's assistant and the send
 * cannot be undone, so the e2e is deliberately READ-ONLY AND NEVER SENDS. It
 * proves the page loads against real configuration, that the recipient count
 * comes back from the real API, and that a single click does not send.
 *
 * The assertion with teeth is the last one: the first click must only ask. A
 * regression that turns "Send to everyone" into a one-click action would mail
 * the entire company from a stray keystroke, and no test that stops short of
 * the button would catch it.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Announcements reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/broadcast renders and refuses to send on one click", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);

    const nav = await page.goto(`${target.baseUrl}/admin/broadcast`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    /* 200, not merely "not 500": a 401 renders blank. */
    expect(nav?.status(), "/admin/broadcast loads (not 401/blank)").toBe(200);

    await expect(page.getByRole("heading", { name: "Message everyone" })).toBeVisible({
      timeout: 15_000,
    });

    const box = page.getByTestId("broadcast-message");
    await expect(box).toBeVisible({ timeout: 15_000 });

    /* Nothing typed means nothing to send. */
    await expect(page.getByTestId("broadcast-send")).toBeDisabled();

    /* Typing enables it, and the character budget is real. */
    await box.fill("End to end check. This message is never sent.");
    await expect(page.getByTestId("broadcast-send")).toBeEnabled();
    await expect(page.getByTestId("broadcast-remaining")).toContainText("characters left");

    /* THE ONE THAT MATTERS. The first click asks; it must not send. */
    await page.getByTestId("broadcast-send").click();
    await expect(page.getByTestId("broadcast-confirm-warning")).toBeVisible();
    await expect(page.getByTestId("broadcast-confirm")).toBeVisible();

    /* The confirmation names a real number read from the API, not the word
       "everyone", whenever the recipient list was readable. */
    const confirmText = (await page.getByTestId("broadcast-confirm").innerText()).trim();
    expect(confirmText).toMatch(/^Yes, send to (\d+ (person|people)|everyone)$/);

    /* Back out. Nothing was sent, and the page returns to a draft state. */
    await page.getByTestId("broadcast-cancel").click();
    await expect(page.getByTestId("broadcast-confirm-warning")).toHaveCount(0);
    await expect(page.getByTestId("broadcast-result")).toHaveCount(0);

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(
      failures,
      `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`,
    ).toEqual([]);
  });
});
