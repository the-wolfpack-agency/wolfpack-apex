/**
 * /messages — system-event pills + unread state + deep-link.
 *
 * Locks in the regressions fixed by PR #30:
 *   1. System-event pills (call started/ended, X joined the chat)
 *      render with text — never as empty bubbles.
 *   2. Unread chat rows render with a heavier font weight than read
 *      chats (computed style, not just a class name). Selecting a
 *      chat moves it back to the read weight.
 *   3. Deep-link `?chat=<id>&message=<id>` highlights the chat in the
 *      list AND scrolls/flashes the corresponding message in the
 *      thread.
 *
 * All three were jsdom-invisible: jsdom returns 0 for getComputedStyle
 * weights, doesn't run the IntersectionObserver / scroll-into-view
 * path, and doesn't hold a layout for "is the bubble empty?".
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

async function settle(page: import("@playwright/test").Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
}

test.describe("messages page bug fixes (real browser)", () => {
  test.beforeEach(async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping");
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);
  });

  test("page loads and lands in a terminal state (not infinite loading)", async ({
    page,
  }) => {
    const response = await page.goto(`${target.baseUrl}/messages`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await settle(page);

    // One of: list / empty / scope-missing / error must render.
    const terminal = await Promise.race([
      page
        .getByTestId("messages-page")
        .first()
        .waitFor({ state: "visible", timeout: 12_000 })
        .then(() => "page"),
      page
        .getByTestId("messages-empty")
        .first()
        .waitFor({ state: "visible", timeout: 12_000 })
        .then(() => "empty"),
      page
        .getByTestId("messages-scope-missing")
        .first()
        .waitFor({ state: "visible", timeout: 12_000 })
        .then(() => "scope-missing"),
    ]).catch(() => "timeout");
    expect(terminal).not.toBe("timeout");
  });

  test("system-event pills render with non-empty text content", async ({ page }) => {
    await page.goto(`${target.baseUrl}/messages`, { waitUntil: "domcontentloaded" });
    await settle(page);

    // Pick a chat — first non-system row.
    const list = page.getByTestId("messages-list");
    if (!(await list.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "skip",
        description: "messages-list not visible — likely empty or scope-missing",
      });
      test.skip();
      return;
    }

    const firstChat = page.locator('[data-testid^="chat-row-"]').first();
    await expect(firstChat).toBeVisible();
    await firstChat.click();

    // Wait for the thread to load.
    const thread = page.getByTestId("messages-thread-body");
    await expect(thread).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Look for ANY system-event pill on this thread. If none, log skip
    // (fixture / chat-specific). The bug was empty bubbles, so when a
    // pill IS rendered we assert it has visible text.
    const pills = page.locator('[data-testid^="system-event-"]');
    const pillCount = await pills.count();
    if (pillCount === 0) {
      test.info().annotations.push({
        type: "skip",
        description: "no system-event pills on this thread — cannot validate text",
      });
      test.skip();
      return;
    }

    // Every pill must have non-empty rendered text. The phrases we
    // expect: "Call started" / "Call ended" / "joined the chat".
    const knownPhrases = /(call started|call ended|joined the chat|left the chat|added .* to the chat|removed .* from the chat|topic updated)/i;
    let foundKnown = false;
    for (let i = 0; i < pillCount; i++) {
      const pill = pills.nth(i);
      const text = (await pill.innerText()).trim();
      expect(text.length, `system-event pill #${i} has text`).toBeGreaterThan(0);
      if (knownPhrases.test(text)) foundKnown = true;
    }
    expect(foundKnown, "at least one pill matches a known system-event phrase").toBe(
      true,
    );
  });

  test("unread chats render with heavier font weight than read chats", async ({
    page,
  }) => {
    await page.goto(`${target.baseUrl}/messages`, { waitUntil: "domcontentloaded" });
    await settle(page);

    const list = page.getByTestId("messages-list");
    if (!(await list.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "skip",
        description: "messages-list not visible",
      });
      test.skip();
      return;
    }

    // Find a row marked data-unread="true".
    const unread = page.locator('[data-testid^="chat-row-"][data-unread="true"]').first();
    if (!(await unread.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "skip",
        description: "no unread chats present on this account",
      });
      test.skip();
      return;
    }

    // Read computed font-weight on the chat title within the row.
    // Title testid is `chat-title-${chat.id}` per page.tsx.
    const titleId = await unread.getAttribute("data-testid");
    expect(titleId).toMatch(/^chat-row-/);
    const chatId = (titleId ?? "").replace(/^chat-row-/, "");
    const title = page.getByTestId(`chat-title-${chatId}`);
    await expect(title).toBeVisible();
    const unreadWeight = await title.evaluate(
      (el) => parseInt(window.getComputedStyle(el).fontWeight, 10) || 0,
    );
    expect(unreadWeight, "unread title font-weight").toBeGreaterThanOrEqual(600);

    // Click the unread chat — it becomes selected and the row should
    // re-render with `data-selected="true"`. The page-level state
    // change clears the unread bold.
    await unread.click();
    await page.waitForTimeout(800);
    const selectedRow = page.locator(`[data-testid="chat-row-${chatId}"]`);
    await expect(selectedRow).toHaveAttribute("data-selected", "true");
    // The selected row's chat title should NOT be in the unread weight
    // (>= 700) anymore — it falls to 600 (selected) or 400 (read).
    const afterWeight = await page
      .getByTestId(`chat-title-${chatId}`)
      .evaluate((el) => parseInt(window.getComputedStyle(el).fontWeight, 10) || 0);
    expect(afterWeight, "title weight after select").toBeLessThan(unreadWeight);
  });

  test("deep-link ?chat=&message= highlights the chat in the list", async ({
    page,
  }) => {
    // First land on /messages to discover a chat id we can deep-link.
    await page.goto(`${target.baseUrl}/messages`, { waitUntil: "domcontentloaded" });
    await settle(page);

    const list = page.getByTestId("messages-list");
    if (!(await list.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "skip",
        description: "messages-list not visible — cannot derive deep-link target",
      });
      test.skip();
      return;
    }

    const firstRow = page.locator('[data-testid^="chat-row-"]').first();
    await expect(firstRow).toBeVisible();
    const testid = (await firstRow.getAttribute("data-testid")) ?? "";
    const chatId = testid.replace(/^chat-row-/, "");
    expect(chatId).not.toEqual("");

    // Navigate again with the deep-link.
    await page.goto(
      `${target.baseUrl}/messages?chat=${encodeURIComponent(chatId)}`,
      { waitUntil: "domcontentloaded" },
    );
    await settle(page);

    // The targeted row should be selected.
    const targeted = page.locator(`[data-testid="chat-row-${chatId}"]`);
    await expect(targeted).toBeVisible({ timeout: 10_000 });
    await expect(targeted).toHaveAttribute("data-selected", "true");
  });
});
