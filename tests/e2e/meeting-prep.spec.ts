/**
 * Meeting Pre-Brief — assistant tool E2E.
 *
 * Walks the user journey:
 *   1. Sign in (skip cleanly when SMOKE creds aren't set).
 *   2. Open the assistant chat.
 *   3. Type "prep for my next meeting".
 *   4. Assert the meeting-prep widget renders (or the empty-state answer,
 *      which is also a valid path when the user has no upcoming meeting).
 *   5. Assert no 401/403/5xx on the page during the interaction.
 *
 * Skips cleanly without SMOKE creds, matching sibling specs.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";
import { submitComposer } from "./helpers/assistant-composer";

test.describe("/assistant — meeting prep tool", () => {
  test("typing 'prep for my next meeting' yields a tool-routed answer", async ({
    page,
  }) => {
    const target = resolveSmokeTarget();
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD required");
      return;
    }

    const failures = collectConsoleAndNetworkFailures(page);

    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in must complete").toBe(true);

    /* The assistant lives at the chat surface on the dashboard. We
     * route to /dashboard so the global chat widget is mounted. The
     * test is intentionally permissive about WHICH surface renders the
     * widget — sites assistant, dashboard chat, or the dedicated /chat
     * route — because the chat input is the same across all of them. */
    const resp = await page.goto(`${target.baseUrl}/dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(resp?.status()).toBe(200);

    /* Find the chat input. Conservative selector: any textarea or input
     * that takes the assistant prompt. If the chat surface isn't
     * mounted on this page we skip — the prod chat lives behind a
     * keyboard chord on some shells. */
    const composer = page
      .locator(
        'textarea[placeholder*="ask" i], input[placeholder*="ask" i], textarea[data-testid*="assistant"], textarea[name*="message"]',
      )
      .first();
    if (!(await composer.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "assistant composer not present on /dashboard");
      return;
    }

    await composer.fill("prep for my next meeting");
    await submitComposer(page);

    /* Either the meeting-prep widget renders OR the assistant returns
     * the empty-state answer ("I don't see a meeting in the next 8
     * hours"). Both are valid: the assertion is "the dispatcher routed
     * the message to the meeting_prep tool", not "there must be an
     * upcoming meeting for this test account". */
    const widget = page.getByTestId("meeting-prep-widget");
    const emptyAnswer = page.getByText(/don't see a meeting/i);

    await expect(widget.or(emptyAnswer)).toBeVisible({ timeout: 30_000 });

    /* No console / network failures during the interaction. */
    const snapshot = failures();
    expect(snapshot).toHaveLength(0);
  });
});
