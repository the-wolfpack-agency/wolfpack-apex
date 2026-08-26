/**
 * Submitting a prompt in the assistant composer, the way a person does.
 *
 * WHY THIS HELPER EXISTS. Seven specs across this suite filled the composer
 * and then called `press("Enter")`, and not one of them ever sent a message.
 * The composer's `handleKeyDown` submits on Cmd/Ctrl+Enter ONLY; a plain Enter
 * inserts a newline in the textarea, exactly as it should for a multi-line
 * prompt box. So every one of those specs typed a sentence, sent nothing,
 * waited for a widget, and timed out, or worse, asserted something weaker that
 * still passed.
 *
 * That is the same shape as the six controls found on 2026-08-26 that were
 * declared, described accurately and never executed: a test written against
 * the shape the author assumed rather than the shape the product produces.
 *
 * The fix is to drive the send BUTTON, which is what a user actually presses
 * and which additionally proves the button enabled itself for the typed text.
 * Guarded by `assistant-composer-submit.test.ts`, which fails the build if a
 * plain Enter press on the composer reappears.
 */

import { expect, type Page } from "@playwright/test";

/**
 * Close the first-run welcome modal if it is up.
 *
 * It is a full-screen backdrop with `aria-modal`, so it swallows the click on
 * the send button. The old specs never noticed because they were pressing a
 * key that sent nothing anyway; fixing the submit path is what surfaced this.
 *
 * Both halves matter. The localStorage flag stops it appearing on subsequent
 * navigations in the same context, and the explicit close handles the modal
 * that is already on screen when we arrive. Neither is enough alone: the flag
 * is read on mount, so setting it after the page has loaded is too late.
 */
export async function dismissWelcomeModal(page: Page): Promise<void> {
  await page
    .evaluate(() => window.localStorage.setItem("instinct_welcome_seen", "1"))
    .catch(() => undefined);

  const close = page.getByTestId("assistant-welcome-modal-close");
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => undefined);
  }
  /* Wait for it to actually leave the page rather than assuming the click
     landed. A backdrop mid-fade still intercepts pointer events. */
  await expect(page.getByTestId("assistant-welcome-modal-backdrop")).toHaveCount(0, {
    timeout: 10_000,
  });
}

/**
 * Send whatever is already typed in the composer.
 *
 * Clicks the send button rather than pressing a key, because that is the
 * affordance a person uses and because the button carries its own enablement
 * rule (`disabled={!input.trim()}`), so a click that works proves the typed
 * text reached React state rather than merely landing in the DOM.
 */
export async function submitComposer(page: Page): Promise<void> {
  await dismissWelcomeModal(page);
  const send = page.getByTestId("assistant-send-btn");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("assistant-composer-input")).toHaveValue("");
}

/**
 * Type a prompt into the assistant composer and send it.
 *
 * Waits for the composer to be enabled before typing. A click that lands
 * before hydration does nothing at all, which is the documented cause of the
 * flaky login specs in this repo.
 */
export async function askAssistant(page: Page, prompt: string): Promise<void> {
  await dismissWelcomeModal(page);
  const composer = page.getByTestId("assistant-composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill(prompt);

  const send = page.getByTestId("assistant-send-btn");
  /* The button is disabled until the input has non-whitespace content, so
     this also asserts the fill actually reached React state rather than
     merely landing in the DOM. */
  await expect(send).toBeEnabled();
  await send.click();

  /* A sent prompt clears the composer. Asserting it here means a future
     regression in the submit path fails at the line that submitted, naming
     the cause, instead of 15 seconds later at a missing widget. */
  await expect(composer).toHaveValue("");
}
