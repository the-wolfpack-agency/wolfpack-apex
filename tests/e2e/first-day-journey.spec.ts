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
import { test, expect, type Page } from "@playwright/test";
import {
  buildJourney,
  WOLFPACK_PROBES,
  type CorpusProbe,
} from "../../src/lib/deployment/first-day-journey";
import { classifyAnswer, scoreJourney, type StepResult } from "../../src/lib/deployment/journey";

const URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.JOURNEY_EMAIL ?? process.env.ADMIN_E2E_EMAIL;
const PASSWORD = process.env.JOURNEY_PASSWORD ?? process.env.ADMIN_E2E_PASSWORD;

const MSG = '[data-testid^="assistant-msg-content-"]';

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

async function signIn(page: Page): Promise<void> {
  await page.goto(`${URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL!);
  await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD!);
  /* Enabled only once hydrated. A click before then does a native GET submit
     and no POST ever happens, which this repo has already been bitten by. */
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();

  /* WAIT FOR THE APP, NOT FOR A NAVIGATION EVENT.
   *
   * This waited on waitForURL, which resolves on a navigation until "load".
   * The app routes client-side after login, so under any load that event may
   * not arrive even though the person is signed in and looking at the
   * composer. It failed exactly once across eight logins in a run against
   * production, and passed on retry, which is the signature of waiting on the
   * wrong signal rather than of a real fault.
   *
   * Being signed in means the app shell is there. Either condition proves it,
   * so whichever arrives first ends the wait. */
  await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45_000 }),
    page
      .locator('input[placeholder*="Ask anything"], textarea[placeholder*="Ask anything"], nav, aside')
      .first()
      .waitFor({ state: "visible", timeout: 45_000 }),
  ]);
}

async function ask(page: Page, question: string, budgetMs: number): Promise<StepResult["latencyMs"] extends never ? never : { latencyMs: number | null; answer: string }> {
  await page.goto(`${URL}/assistant`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  /* The first-run welcome modal covers the composer. */
  await page.keyboard.press("Escape").catch(() => undefined);

  const input = page
    .locator('input[placeholder*="Ask anything"], textarea[placeholder*="Ask anything"]')
    .first();
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await input.fill(question);

  const started = Date.now();
  /* The composer's own hint says "Cmd+Enter to send". Plain Enter inserts a
     newline and nothing is ever submitted, which cost a full round of bogus
     "timed out" readings before anybody read the hint. */
  await input.press("Meta+Enter");

  try {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length > 1,
      MSG,
      { timeout: budgetMs + 20_000 },
    );
  } catch {
    return { latencyMs: null, answer: "" };
  }
  const latencyMs = Date.now() - started;
  /* Let a streaming answer settle before reading it, or the classifier judges
     a half-written sentence. */
  await page.waitForTimeout(2_000);
  return { latencyMs, answer: (await page.locator(MSG).last().textContent()) ?? "" };
}

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
   * behaviour were all still unknown.
   *
   * Somebody standing up a client instance needs the whole picture from one
   * run, including everything downstream of the first problem. Each step signs
   * in for itself, so they are genuinely independent. */
  test.describe.configure({ timeout: 180_000 });

  const results: StepResult[] = [];

  for (const step of STEPS) {
    test(`${step.id}: ${step.ask}`, async ({ page }) => {
      await signIn(page);
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
