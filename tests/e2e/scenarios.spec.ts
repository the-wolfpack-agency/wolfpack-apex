/**
 * Walk whole jobs against a deployment, not single questions.
 *
 *   PROD_URL=https://client.vercel.app \
 *   JOURNEY_EMAIL=... JOURNEY_PASSWORD=... \
 *   SCENARIO_DOCUMENT="their work order" \
 *   npx playwright test tests/e2e/scenarios.spec.ts
 *
 * WHY THIS EXISTS ALONGSIDE first-day-journey.spec.ts. That one asks a
 * question at a time and every step passed while the product was unusable for
 * a real task. Walking one continuous conversation on 2026-08-29 failed at all
 * three turns, each differently, and none of it was visible one question at a
 * time: turn two only fails because of what turn one asked.
 *
 * Each scenario runs in its OWN conversation, so a failure in one cannot
 * cascade into the next and be reported as two problems.
 */
import { test, expect, type Page } from "@playwright/test";
import { buildScenarios, type Scenario } from "../../src/lib/deployment/scenarios";
import { classifyAnswer } from "../../src/lib/deployment/journey";

const URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.JOURNEY_EMAIL ?? process.env.ADMIN_E2E_EMAIL;
const PASSWORD = process.env.JOURNEY_PASSWORD ?? process.env.ADMIN_E2E_PASSWORD;

/* Both the question and the reply carry this testid, so a turn adds TWO. */
const MSG = '[data-testid^="assistant-msg-content-"]';

const SCENARIOS: Scenario[] = buildScenarios({
  ...(process.env.SCENARIO_DOCUMENT ? { documentName: process.env.SCENARIO_DOCUMENT } : {}),
  ...(process.env.SCENARIO_CONTAINS ? { documentContains: process.env.SCENARIO_CONTAINS } : {}),
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`${URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL!);
  await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD!);
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();
  /* The app routes client-side, so a navigation event may never arrive even
     though the person is signed in. Either signal ends the wait. */
  await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45_000 }),
    page
      .locator('input[placeholder*="Ask anything"], textarea[placeholder*="Ask anything"], nav')
      .first()
      .waitFor({ state: "visible", timeout: 45_000 }),
  ]);
}

async function ask(
  page: Page,
  text: string,
  budgetMs: number,
): Promise<{ latencyMs: number | null; answer: string }> {
  const input = page
    .locator('input[placeholder*="Ask anything"], textarea[placeholder*="Ask anything"]')
    .first();
  await input.waitFor({ state: "visible", timeout: 20_000 });

  /* Counted BEFORE sending and waited for TWO more. Waiting for one returns
     the moment the user's own message renders, which made every timing in an
     earlier run read as 10ms and handed one assertion the question as if it
     were the answer. */
  const before = await page.locator(MSG).count();
  await input.fill(text);
  const started = Date.now();
  /* The composer's own hint says Cmd+Enter. Plain Enter inserts a newline. */
  await input.press("Meta+Enter");

  try {
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length >= n + 2,
      { sel: MSG, n: before },
      { timeout: budgetMs + 20_000 },
    );
  } catch {
    return { latencyMs: null, answer: "" };
  }
  const latencyMs = Date.now() - started;
  await page.waitForTimeout(1_800);
  return { latencyMs, answer: (await page.locator(MSG).last().textContent()) ?? "" };
}

test.describe("whole jobs on this deployment", () => {
  test.skip(
    !URL || !EMAIL || !PASSWORD,
    "needs PROD_URL + JOURNEY_EMAIL + JOURNEY_PASSWORD. Skipped loudly rather than passing on nothing.",
  );
  test.describe.configure({ timeout: 240_000 });

  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: ${scenario.goal}`, async ({ page }) => {
      await signIn(page);
      /* Its own conversation, so one scenario's failure cannot cascade into
         the next and be counted twice. */
      await page.goto(`${URL}/assistant`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);

      const transcript: string[] = [];
      for (const [i, turn] of scenario.turns.entries()) {
        const { latencyMs, answer } = await ask(page, turn.say, turn.budgetMs);
        const kind = classifyAnswer({ answer, latencyMs });
        const flat = answer.replace(/\s+/g, " ").trim();
        transcript.push(`  ${i + 1}. > ${turn.say}\n     [${kind}, ${latencyMs ?? "no"}ms] ${flat.slice(0, 160)}`);

        const detail =
          `\n${scenario.goal}\n` +
          `turn ${i + 1} — ${turn.because}\n` +
          transcript.join("\n");

        expect(turn.expect, `${detail}\n  expected one of ${turn.expect.join("/")}`).toContain(kind);
        if (latencyMs !== null) {
          expect(latencyMs, `${detail}\n  over its ${turn.budgetMs}ms budget`).toBeLessThanOrEqual(
            turn.budgetMs,
          );
        }
        if (turn.mustContain) {
          expect(
            flat.toLowerCase(),
            `${detail}\n  did not contain "${turn.mustContain}"`,
          ).toContain(turn.mustContain.toLowerCase());
        }
      }
    });
  }
});
