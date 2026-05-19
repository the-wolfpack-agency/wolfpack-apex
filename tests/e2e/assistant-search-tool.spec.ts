/**
 * /assistant — `search` tool E2E (real browser, real backend).
 *
 * Three scenarios:
 *
 *   1. "Search Porsche" routes to the `search` tool and renders the
 *      natural-language summary the tool emits (Found N results … OR
 *      No results found …).
 *   2. Parity: GET /api/search?q=porsche returns the same total count
 *      that the assistant's natural-language summary cites.
 *   3. CRM-shaped "find the contact for Acme" does NOT trigger the
 *      `search` tool — guards the registration-order intent matching
 *      between the universal search tool and the CRM connector tools.
 *
 * Auth follows the same pattern as the sibling assistant + search
 * specs (`assistant-meeting-grounded.spec.ts`,
 * `assistant-debug.spec.ts`, `search-autofocus.spec.ts`): real
 * credentials sign-in via `signInIfPossible` against PROD_URL (or
 * localhost dev), skipped cleanly when SMOKE_TEST_EMAIL /
 * SMOKE_TEST_PASSWORD are absent.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const SUMMARY_RE = /Found\s+(\d+)\s+results?\s+for\s+"([^"]+)"/i;
const NO_RESULTS_RE = /No\s+results\s+found\s+for\s+"([^"]+)"/i;

async function signIn(page: import("@playwright/test").Page) {
  const signedIn = await signInIfPossible(page, target);
  expect(signedIn).toBe(true);
}

async function openAssistant(page: import("@playwright/test").Page) {
  const response = await page.goto(`${target.baseUrl}/assistant`, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status() ?? 0).toBeLessThan(400);
  const composer = page.getByPlaceholder(/ask anything/i).first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  return composer;
}

/**
 * Send a message through the assistant composer and wait for the
 * assistant's POST response + the rendered message bubble to settle.
 * Returns the lowercased rendered text of the latest assistant
 * message.
 */
async function sendAndCaptureAnswer(
  page: import("@playwright/test").Page,
  composer: ReturnType<import("@playwright/test").Page["getByPlaceholder"]>,
  message: string,
): Promise<string> {
  // Snapshot existing assistant-msg-content nodes so we can wait for a
  // NEW one to appear after submit (avoids reading the previous
  // scenario's last bubble in a serial run).
  const priorCount = await page
    .locator('[data-testid^="assistant-msg-content-"]')
    .count();

  await composer.fill(message);

  const assistantResp = page.waitForResponse(
    (r) =>
      r.url().includes("/api/assistant") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await composer.press("Meta+Enter");
  const resp = await assistantResp;
  expect(resp.status()).toBeLessThan(500);

  // Wait for a NEW assistant bubble to render (strictly greater than
  // the prior snapshot).
  await expect
    .poll(
      async () =>
        page.locator('[data-testid^="assistant-msg-content-"]').count(),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(priorCount);

  const last = page
    .locator('[data-testid^="assistant-msg-content-"]')
    .last();
  await expect(last).toBeVisible({ timeout: 30_000 });
  return (await last.innerText()).trim();
}

test.describe("assistant search tool", () => {
  test.beforeEach(async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(
        true,
        "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping",
      );
      return;
    }
    await signIn(page);
  });

  test('"Search Porsche" routes to the search tool and renders the summary', async ({
    page,
  }) => {
    const composer = await openAssistant(page);
    const answer = await sendAndCaptureAnswer(page, composer, "Search Porsche");

    /* The `search` tool's summaryAnswer() produces exactly one of two
       shapes:  Found N result(s) for "porsche": …    OR
                No results found for "porsche".
       Either is acceptable; this is a real environment that may have
       zero matching data. The lowercased query is what the tool sees
       because matchSearchIntent() captures the post-verb tail
       verbatim. */
    const summaryMatch = SUMMARY_RE.exec(answer);
    const emptyMatch = NO_RESULTS_RE.exec(answer);
    expect(
      Boolean(summaryMatch || emptyMatch),
      `Assistant answer did not match the search-tool summary shape. Got: ${answer.slice(0, 500)}`,
    ).toBe(true);

    /* Whichever shape rendered, the quoted query must be "porsche"
       (case-insensitive) — the tool echoes the user's typed query
       back, not a paraphrase. */
    const quoted = (summaryMatch?.[2] ?? emptyMatch?.[1] ?? "").toLowerCase();
    expect(quoted).toBe("porsche");
  });

  test("parity: /api/search count matches the assistant summary count", async ({
    page,
    request,
  }) => {
    /* Pull the auth token from localStorage so the API call uses the
       same identity as the assistant flow. `runSearch` is RLS-scoped
       per-user, so using a different token would defeat parity. */
    const token = await authToken(page);
    test.skip(
      !token,
      "No instinct_token in localStorage — sign-in did not establish a real session; skipping parity check.",
    );

    const apiResp = await request.get(
      `${target.baseUrl}/api/search?q=porsche&limit=20`,
      {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        timeout: 30_000,
      },
    );
    expect(apiResp.status(), `GET /api/search → ${apiResp.status()}`).toBe(200);
    const body = (await apiResp.json()) as {
      results: unknown[];
      counts: {
        chats: number;
        channels: number;
        emails: number;
        calendar: number;
        knowledge: number;
      };
    };
    const apiTotal = Array.isArray(body.results) ? body.results.length : 0;

    const composer = await openAssistant(page);
    const answer = await sendAndCaptureAnswer(page, composer, "search porsche");

    const summary = SUMMARY_RE.exec(answer);
    const empty = NO_RESULTS_RE.exec(answer);
    const uiTotal = summary ? Number(summary[1]) : empty ? 0 : NaN;
    expect(
      Number.isFinite(uiTotal),
      `Could not parse a count out of the assistant summary. Got: ${answer.slice(0, 500)}`,
    ).toBe(true);

    expect(
      uiTotal,
      `Parity mismatch: API said ${apiTotal} results, assistant said ${uiTotal}. ` +
        `If the API has 0, the assistant must say "No results"; otherwise totals must match exactly.`,
    ).toBe(apiTotal);
  });

  test("CRM-shaped query does NOT trigger the search tool", async ({ page }) => {
    const composer = await openAssistant(page);
    const answer = await sendAndCaptureAnswer(
      page,
      composer,
      "find the contact for Acme",
    );

    /* The universal `search` tool emits a very specific summary shape.
       If the CRM intent guard worked correctly, neither the
       Found-N-results nor the No-results-for shape should appear: the
       CRM connector tool (or the fallback assistant model response)
       handled it instead. */
    expect(
      SUMMARY_RE.test(answer),
      `Assistant unexpectedly used the universal search summary for a CRM-shaped query. Got: ${answer.slice(0, 500)}`,
    ).toBe(false);
    expect(
      NO_RESULTS_RE.test(answer),
      `Assistant unexpectedly used the universal search "no results" summary for a CRM-shaped query. Got: ${answer.slice(0, 500)}`,
    ).toBe(false);
  });
});
