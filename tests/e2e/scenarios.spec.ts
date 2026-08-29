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
import { test, expect } from "@playwright/test";
import { buildScenarios, type Scenario } from "../../src/lib/deployment/scenarios";
import { classifyAnswer } from "../../src/lib/deployment/journey";
import { signIn, openAssistant, ask, flatten } from "./helpers/assistant";

const URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.JOURNEY_EMAIL ?? process.env.ADMIN_E2E_EMAIL;
const PASSWORD = process.env.JOURNEY_PASSWORD ?? process.env.ADMIN_E2E_PASSWORD;

const SCENARIOS: Scenario[] = buildScenarios({
  ...(process.env.SCENARIO_DOCUMENT ? { documentName: process.env.SCENARIO_DOCUMENT } : {}),
  ...(process.env.SCENARIO_CONTAINS ? { documentContains: process.env.SCENARIO_CONTAINS } : {}),
});

test.describe("whole jobs on this deployment", () => {
  test.skip(
    !URL || !EMAIL || !PASSWORD,
    "needs PROD_URL + JOURNEY_EMAIL + JOURNEY_PASSWORD. Skipped loudly rather than passing on nothing.",
  );
  test.describe.configure({ timeout: 240_000 });

  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: ${scenario.goal}`, async ({ page }) => {
      await signIn(page, URL!, EMAIL!, PASSWORD!);
      /* Its own conversation, so one scenario's failure cannot cascade into
         the next and be counted twice. */
      await openAssistant(page, URL!);

      const transcript: string[] = [];
      for (const [i, turn] of scenario.turns.entries()) {
        const { latencyMs, answer } = await ask(page, turn.say, turn.budgetMs);
        const kind = classifyAnswer({ answer, latencyMs });
        const flat = flatten(answer);
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
