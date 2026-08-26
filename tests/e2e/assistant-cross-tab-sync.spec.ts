/**
 * Assistant chat live-updates — two-tab cross-tab sync via BroadcastChannel.
 *
 * Repro for Max's 2026-05-22 feedback: "my chat messages don't live update.
 * It was only after refresh." Root cause: each mount of the assistant
 * (inline `/assistant` page, floating widget, second tab) held its own
 * local `messages` state with no real-time sync. A message sent in tab A
 * never showed up in tab B until B was refreshed.
 *
 * The fix lives in [src/lib/hooks/useChatLiveUpdates.ts]. This E2E pins
 * the user-visible promise: send in tab A, see it in tab B within a
 * couple of seconds, no manual refresh needed.
 *
 * Two pages share one BrowserContext so they share the same origin and
 * therefore the same BroadcastChannel namespace. (Two contexts would
 * NOT share BC — that's the intended security boundary.)
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";
import { submitComposer } from "./helpers/assistant-composer";

const target = resolveSmokeTarget();

const CONV_ID = "conv-cross-tab-e2e";
const FIRST_USER_MSG_ID = "msg-user-1";
const FIRST_ASSISTANT_MSG_ID = "msg-assistant-1";

/** Conversation state shared across the mocked API responses. Mutated
 *  by the POST handler so a subsequent GET in the OTHER tab returns
 *  the just-sent + just-replied messages. */
const conversationState: {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
} = { messages: [] };

function nowIso(): string {
  return new Date().toISOString();
}

/** Install API mocks on a page. We mock:
 *    GET /api/assistant?conversations=true   → conversations list
 *    GET /api/assistant?conversationId=...   → message history
 *    POST /api/assistant                     → echo a fake assistant reply
 *    POST /api/analytics                     → no-op 200
 */
async function installAssistantMocks(page: Page): Promise<void> {
  await page.route("**/api/assistant**", async (route: Route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "GET" && url.includes("conversations=true")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: [
            {
              id: CONV_ID,
              title: "Cross-tab sync",
              updated_at: nowIso(),
            },
          ],
        }),
      });
      return;
    }
    if (req.method() === "GET" && url.includes("conversationId=")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: conversationState.messages }),
      });
      return;
    }
    if (req.method() === "POST") {
      const body = (() => {
        try {
          return JSON.parse(req.postData() || "{}");
        } catch {
          return {};
        }
      })();
      const userMsg = {
        id: FIRST_USER_MSG_ID,
        role: "user" as const,
        content: typeof body.message === "string" ? body.message : "",
        timestamp: nowIso(),
      };
      const assistantMsg = {
        id: FIRST_ASSISTANT_MSG_ID,
        role: "assistant" as const,
        content: "Echo from the mocked assistant.",
        timestamp: nowIso(),
      };
      conversationState.messages.push(userMsg, assistantMsg);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          messageId: assistantMsg.id,
          conversationId: CONV_ID,
          source: "live",
          answer: assistantMsg.content,
          tokensUsed: 1,
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/analytics", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

test.describe("assistant chat — cross-tab BroadcastChannel sync", () => {
  test.beforeEach(() => {
    conversationState.messages = [];
  });

  test("tab B sees the message sent in tab A within 3 seconds, no refresh", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      // Open BOTH tabs in the SAME context so they share origin + BroadcastChannel.
      const tabA = await context.newPage();
      const tabB = await context.newPage();
      const snapshotA = collectConsoleAndNetworkFailures(tabA);
      const snapshotB = collectConsoleAndNetworkFailures(tabB);

      // Auth + mocks on both tabs.
      await signInIfPossible(tabA, target).catch(() => undefined);
      await signInIfPossible(tabB, target).catch(() => undefined);
      await stubInstinctSession(tabA);
      await stubInstinctSession(tabB);
      await installAssistantMocks(tabA);
      await installAssistantMocks(tabB);

      // Both tabs open the same conversation.
      await tabA.goto(`${target.baseUrl}/assistant?conversation=${CONV_ID}`);
      await tabB.goto(`${target.baseUrl}/assistant?conversation=${CONV_ID}`);

      // Wait for both to render the input.
      await expect(tabA.getByPlaceholder(/ask|message|type/i).first()).toBeVisible();
      await expect(tabB.getByPlaceholder(/ask|message|type/i).first()).toBeVisible();

      // Tab B initially has NO assistant message visible.
      await expect(
        tabB.getByText("Echo from the mocked assistant.").first(),
      ).toHaveCount(0);

      // Send a message from Tab A.
      const input = tabA.getByPlaceholder(/ask|message|type/i).first();
      await input.fill("hello from tab A");
      await submitComposer(tabA);

      // Tab A should show the assistant reply.
      await expect(
        tabA.getByText("Echo from the mocked assistant.").first(),
      ).toBeVisible({ timeout: 5_000 });

      // **The promise of the feature**: Tab B sees the new messages
      // without being refreshed. BroadcastChannel + the silent
      // re-fetch should land within ~1-2s on a normal machine.
      await expect(
        tabB.getByText("Echo from the mocked assistant.").first(),
      ).toBeVisible({ timeout: 5_000 });

      // No CSP violations, no unexpected XHR failures on either tab.
      expect(snapshotA()).toEqual([]);
      expect(snapshotB()).toEqual([]);

      await tabA.close();
      await tabB.close();
    } finally {
      await context.close();
    }
  });

  test("tabs in DIFFERENT contexts do NOT cross-pollinate (origin isolation)", async ({ browser }) => {
    // Defensive check: cross-tab sync must respect origin/context
    // boundaries. Two BrowserContexts simulate two unrelated browsers
    // (or two different user profiles). They MUST NOT share state.
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    try {
      const tabIso1 = await ctx1.newPage();
      const tabIso2 = await ctx2.newPage();
      const stateIso1 = {
        messages: [] as { id: string; role: "user" | "assistant"; content: string; timestamp: string }[],
      };
      const stateIso2 = {
        messages: [] as { id: string; role: "user" | "assistant"; content: string; timestamp: string }[],
      };

      // Each context gets its OWN state so cross-pollination would be visible.
      async function mockFor(page: Page, state: typeof stateIso1): Promise<void> {
        await page.route("**/api/assistant**", async (route: Route) => {
          const req = route.request();
          const url = req.url();
          if (req.method() === "GET" && url.includes("conversations=true")) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                conversations: [{ id: CONV_ID, title: "iso", updated_at: nowIso() }],
              }),
            });
            return;
          }
          if (req.method() === "GET" && url.includes("conversationId=")) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ messages: state.messages }),
            });
            return;
          }
          if (req.method() === "POST") {
            const body = (() => {
              try {
                return JSON.parse(req.postData() || "{}");
              } catch {
                return {};
              }
            })();
            state.messages.push(
              {
                id: `user-${state.messages.length}`,
                role: "user",
                content: typeof body.message === "string" ? body.message : "",
                timestamp: nowIso(),
              },
              {
                id: `asst-${state.messages.length}`,
                role: "assistant",
                content: "isolated reply",
                timestamp: nowIso(),
              },
            );
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                messageId: `asst-${state.messages.length}`,
                conversationId: CONV_ID,
                source: "live",
                answer: "isolated reply",
                tokensUsed: 1,
              }),
            });
            return;
          }
          await route.continue();
        });
        await page.route("**/api/analytics", async (route: Route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
        );
      }

      await stubInstinctSession(tabIso1);
      await stubInstinctSession(tabIso2);
      await mockFor(tabIso1, stateIso1);
      await mockFor(tabIso2, stateIso2);

      await tabIso1.goto(`${target.baseUrl}/assistant?conversation=${CONV_ID}`);
      await tabIso2.goto(`${target.baseUrl}/assistant?conversation=${CONV_ID}`);

      const input1 = tabIso1.getByPlaceholder(/ask|message|type/i).first();
      await input1.fill("only context 1 should see this");
      await submitComposer(tabIso1);

      await expect(tabIso1.getByText("isolated reply").first()).toBeVisible({
        timeout: 5_000,
      });

      // Context 2 must NOT receive the broadcast — origin isolation.
      // Give it a generous window to NOT show the reply.
      await tabIso2.waitForTimeout(2_500);
      await expect(tabIso2.getByText("isolated reply").first()).toHaveCount(0);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
