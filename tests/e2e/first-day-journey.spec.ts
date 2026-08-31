/**
 * Drive the first day against a real deployment and report what a person gets.
 *
 * POINT IT AT A CLIENT DEPLOYMENT ON DAY ONE:
 *
 *   PROD_URL=https://their-instance.vercel.app \
 *   JOURNEY_EMAIL=... JOURNEY_PASSWORD=... \
 *   npx playwright test tests/e2e/first-day-journey.spec.ts
 *
 * WHY IT IS NOT PART OF THE NORMAL SUITE. It types real questions into a real
 * deployment, which spends model tokens and writes conversation rows. It runs
 * when somebody is standing an instance up or checking one, not on every push,
 * and it skips loudly with a reason rather than quietly passing when it has no
 * credentials.
 *
 * WHAT IT CATCHES THAT THE OTHER SUITES CANNOT. Unit tests run against
 * fixtures. Health probes prove a connector responds. Neither can see a healthy
 * stack that still hands somebody the wrong thing, which is exactly what was
 * found on the first manual run: the onboarding's own "ask our documents"
 * prompt returned a tour of the Docs page while SharePoint was connected,
 * search worked, and the same question phrased naturally answered correctly
 * with a citation in 1.8 seconds.
 */
import { test, expect } from "@playwright/test";
import {
  buildJourney,
  WOLFPACK_PROBES,
  type CorpusProbe,
} from "../../src/lib/deployment/first-day-journey";
import { classifyAnswer, scoreJourney, type StepResult } from "../../src/lib/deployment/journey";
import { signIn, openAssistant, ask } from "./helpers/assistant";

const URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.JOURNEY_EMAIL ?? process.env.ADMIN_E2E_EMAIL;
const PASSWORD = process.env.JOURNEY_PASSWORD ?? process.env.ADMIN_E2E_PASSWORD;

/**
 * Questions THIS deployment's own documents can answer, as JSON.
 *
 *   JOURNEY_PROBES='[{"ask":"what is our refund window?"}]'
 *
 * Omitted entirely on a client instance until somebody supplies theirs, and
 * the run then reports that document retrieval was not covered rather than
 * passing on the universal steps alone. Defaults to ours ONLY when pointed at
 * our own deployment, because our probes are configuration and mean nothing
 * anywhere else.
 */
function corpusProbes(): CorpusProbe[] {
  const raw = process.env.JOURNEY_PROBES;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as CorpusProbe[];
    } catch {
      /* Reported below rather than thrown: a malformed variable should not
         take down the universal steps, but it must not pass silently either. */
      console.warn("JOURNEY_PROBES is not valid JSON; running universal steps only.");
    }
    return [];
  }
  return URL?.includes("wolfpack-instinct") ? WOLFPACK_PROBES : [];
}

const STEPS = buildJourney({ corpusProbes: corpusProbes() });

test.describe("the first day on this deployment", () => {
  test.skip(
    !URL || !EMAIL || !PASSWORD,
    "needs PROD_URL + JOURNEY_EMAIL + JOURNEY_PASSWORD. Skipped loudly rather than passing on nothing.",
  );
  /* NOT serial, and that distinction is the whole point of the tool.
   *
   * Serial mode stops every remaining test once one fails, which is right for a
   * dependent flow and wrong for a survey. The first run of this against
   * production failed on step 3 and skipped steps 4, 5 and 6, reporting "3 did
   * not run" for a deployment whose calendar, capability and confabulation
   * behavior were all still unknown.
   *
   * Somebody standing up a client instance needs the whole picture from one
   * run, including everything downstream of the first problem. Each step signs
   * in for itself, so they are genuinely independent. */
  test.describe.configure({ timeout: 180_000 });

  const results: StepResult[] = [];

  for (const step of STEPS) {
    test(`${step.id}: ${step.ask}`, async ({ page }) => {
      await signIn(page, URL!, EMAIL!, PASSWORD!);
      await openAssistant(page, URL!);
      const { latencyMs, answer } = await ask(page, step.ask, step.budgetMs);
      const kind = classifyAnswer({ answer, latencyMs });
      results.push({ step, kind, latencyMs, answer });

      const verdict = scoreJourney([{ step, kind, latencyMs, answer }]).verdicts[0]!;
      /* The failure message carries the question, what came back, and why it
         is wrong, so a reader never has to open a trace to understand it. */
      expect(
        verdict.ok,
        `${step.id} — ${verdict.problem ?? ""}\n` +
          `  because: ${step.because}\n` +
          `  asked: ${step.ask}\n` +
          `  got (${kind}, ${latencyMs ?? "no"}ms): ${answer.replace(/\s+/g, " ").slice(0, 240)}`,
      ).toBe(true);
    });
  }

  test.afterAll(() => {
    if (results.length === 0) return;
    const report = scoreJourney(results);
    console.log(
      `\nFirst-day journey: ${report.passed}/${results.length} steps behaved` +
        `${report.slowestMs !== null ? `, slowest ${report.slowestMs}ms` : ""}.`,
    );
    for (const p of report.problems) console.log(`  FAIL ${p.step.id}: ${p.problem}`);

    /* WHAT WAS NOT CHECKED, SAID OUT LOUD. Without probes this run proves the
       product responds, refuses cleanly and does not confabulate. It proves
       NOTHING about whether their documents can be searched, and a green run
       that implied otherwise would be the more dangerous outcome. */
    const corpusSteps = results.filter((r) => r.step.id.startsWith("corpus-"));
    if (corpusSteps.length === 0) {
      console.log(
        "  NOT COVERED: document retrieval. Supply JOURNEY_PROBES with a question\n" +
          "  this deployment's own documents answer, e.g.\n" +
          `  JOURNEY_PROBES='[{"ask":"what is our refund window?"}]'`,
      );
    }
    if (report.ready) {
      console.log(
        corpusSteps.length > 0
          ? "  Deployment is ready for somebody's first day."
          : "  Universal checks passed. Document retrieval still unverified.",
      );
    }
  });
});
