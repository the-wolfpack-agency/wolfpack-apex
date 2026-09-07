/**
 * A client, asking the assistant a question, in a real browser.
 *
 * WHY THIS EXISTS. The 400+ jest suite and the DB-level retrieval evals both
 * pass while the thing a client actually touches — type a question, read the
 * answer, click a source — breaks at the render layer. Every failure this week
 * lived exactly there and none of the other layers saw it:
 *
 *   - A raw URL bled into the answer because a filename carried "[36]" and broke
 *     markdown link parsing (fixed #676). Invisible to jest; obvious to a reader.
 *   - The blank-answer / 401 class the whole product has spent days learning to
 *     tell apart from an honest empty state.
 *   - The model + token attribution row beside "AI generated" is a deliberate,
 *     client-facing feature (which model answered, at what cost). Removing it is
 *     a regression, not a cleanup — this asserts it stays.
 *
 * WHAT IT PROVES AND WHAT IT SKIPS. It needs a real session, so it runs only
 * when PROD_URL + SMOKE_TEST_EMAIL/PASSWORD are present (they are, in CI). With
 * no credentials it SKIPS WITH A REASON rather than passing hollowly — a green
 * localhost run would answer a different question than the one this file asks.
 *
 * Emits e2e.reality_check_ran either way so the learning loop sees which specs
 * actually run vs which quietly never do.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
  expectRendered,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

/* A question the corpus can actually answer (from the retrieval eval set), so a
   healthy system returns real content rather than an honest "I don't hold that". */
const CLIENT_QUESTION = "what training do brand ambassadors get";

test.describe("the assistant, driven the way a client drives it", () => {
  test.skip(
    !target.isProduction || !target.email || !target.password,
    "needs PROD_URL + SMOKE_TEST_EMAIL/PASSWORD. A localhost/no-session run would not answer the question this file exists for.",
  );

  test("asks a question and gets a rendered answer with clean sources and attribution", async ({
    page,
    request,
  }) => {
    const started = Date.now();
    const snapshot = collectConsoleAndNetworkFailures(page);
    let result: "pass" | "fail" = "fail";
    let note = "";

    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn, "sign-in should be attempted with the smoke credentials").toBe(true);

      await page.goto(`${target.baseUrl}/assistant`, { waitUntil: "domcontentloaded" });
      await expectRendered(page, "/assistant", ["ask anything", "assistant", "instinct"]);

      /* Type and send exactly as a person would. */
      const composer = page.locator('[data-testid="assistant-composer-input"]');
      await composer.waitFor({ state: "visible", timeout: 20_000 });
      await composer.fill(CLIENT_QUESTION);
      await page.locator('[data-testid="assistant-send-btn"]').click();

      /* The first assistant message must render real content, not a blank
         bubble and not a stuck spinner. */
      const answer = page.locator('[data-testid="assistant-msg-content-0"]');
      await answer.waitFor({ state: "visible", timeout: 45_000 });
      await expect
        .poll(async () => (await answer.innerText().catch(() => "")).trim().length, {
          timeout: 45_000,
          message: "assistant answer never rendered non-empty content",
        })
        .toBeGreaterThan(20);

      const answerText = (await answer.innerText()).trim();

      /* THE #676 REGRESSION, ASSERTED. A raw markdown link must never leak into
         the visible answer — a filename with "[36]" is what broke parsing and
         printed "](https://…" to the client. */
      expect(
        answerText,
        `raw markdown link leaked into the answer: ${JSON.stringify(answerText.slice(0, 200))}`,
      ).not.toMatch(/\]\(https?:\/\//);

      /* Any source the answer cites must be a real, clickable anchor — the
         clean source cards we shipped — not bare URL text. When the answer
         cites nothing (an honest "closest things I hold"), that's valid too. */
      const anchorCount = await page.locator('[data-testid="assistant-msg-content-0"] a[href]').count();
      const citesSomething = /source|closest|i hold|\bhttp/i.test(answerText);
      if (citesSomething) {
        expect(
          anchorCount,
          "answer references sources but rendered none as clickable links",
        ).toBeGreaterThan(0);
      }

      /* THE ATTRIBUTION ROW, ASSERTED. The model/token badge beside "AI
         generated" (or the "Zero tokens" brain-hit badge) is a client-facing
         feature; its absence is a regression. One of them must be present. */
      const attribution = page.locator(
        '[data-testid="assistant-model-badge"], [data-testid="assistant-snapshot-badge"]',
      );
      const hasBadge = (await attribution.count()) > 0;
      const bodyText = (await page.locator("body").innerText()).toLowerCase();
      expect(
        hasBadge || /ai generated|zero tokens/.test(bodyText),
        "the model/token attribution row is missing — that row is an intentional feature, not noise",
      ).toBe(true);

      /* No CSP or 401/403/5xx fetch failures while the client used the page. */
      await page.waitForTimeout(3_000);
      const failures = snapshot();
      expect(
        failures,
        `CSP/network failures during the assistant journey:\n${failures
          .map((f) => `  - [${f.kind}] ${f.detail}`)
          .join("\n")}`,
      ).toEqual([]);

      result = "pass";
      note = `answered in ${Date.now() - started}ms, ${anchorCount} source link(s)`;
    } catch (err) {
      note = err instanceof Error ? err.message.slice(0, 160) : "unknown failure";
      throw err;
    } finally {
      const token = await authToken(page).catch(() => "");
      await recordRealityCheckRun(request, target, token, {
        spec: "assistant-user-journey",
        result,
        duration_ms: Date.now() - started,
        note,
      });
    }
  });
});
