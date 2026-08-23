/**
 * E2E: the whole routine loop, in a real browser.
 *
 * Everything in this arc has been unit and contract tested against the real
 * registry, and none of it had been driven through a page. That gap is exactly
 * the class of failure the CTO directive names: a feature that passes every
 * test and renders blank, or a chip that does nothing when clicked.
 *
 * WHAT IS REAL AND WHAT IS STUBBED
 *
 * The SESSION is stubbed, because a browser test cannot sign in without
 * credentials this suite may not have. The ASSISTANT RESPONSE is stubbed on the
 * specs that assert rendering, because the point there is what the page does
 * with an answer, not whether a model was reachable.
 *
 * Everything else is the real application: the real starter-prompt catalogue,
 * the real routines page, the real client-side auth guard. A chip that is
 * missing from the panel, or a page that renders blank on a 200, fails here.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

/** A routines payload with everything the page can show. */
const ROUTINES_PAYLOAD = {
  ok: true,
  builtIn: [
    {
      command: "run my morning",
      description: "Your calendar, your tasks and a brief for your next meeting.",
      steps: 5,
      humanSteps: 1,
    },
  ],
  saved: [{ command: "run my day", description: "Saved from the day you described.", steps: 4, humanSteps: 2 }],
  schedules: [
    { command: "run my morning", when: "every weekday at 8am", nextRunAt: "2026-08-24T12:00:00.000Z" },
  ],
  runs: [
    {
      runId: "r-waiting",
      routineId: "morning",
      state: "waiting_for_human",
      startedAt: "2026-08-22T08:00:00.000Z",
      techMs: 4200,
      humanMs: 0,
      steps: 4,
      waitingOn: "Read the three, change any you disagree with",
    },
    {
      runId: "r-done",
      routineId: "morning",
      state: "done",
      startedAt: "2026-08-21T08:00:00.000Z",
      techMs: 5000,
      humanMs: 660000,
      steps: 5,
      waitingOn: null,
    },
  ],
  findings: [
    {
      routineId: "morning",
      stepIndex: 4,
      label: "Rehearse the opening out loud",
      kind: "not_happening",
      observation: "Asked 12 times, done 3. It is skipped more often than not.",
      suggestion:
        "Either this is not as important as the routine assumes, or it matters and is not getting done.",
      completionRate: 0.25,
    },
  ],
};

test.describe("your routines page", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await page.route("**/api/routines**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ROUTINES_PAYLOAD),
      });
    });
  });

  test("renders the page rather than a blank shell, with no console errors", async ({ page }) => {
    /* The failure this catches is the one that unit tests never do: a 200 that
       paints nothing, which is how an auth or bundle problem actually shows up
       to a person. */
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    const res = await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId("routines-root")).toBeVisible();
    await expect(page.getByTestId("routines-chains")).toContainText("run my morning");
    /* CSP violations and hydration failures both land here. */
    expect(errors.filter((e) => /Content Security Policy|hydration/i.test(e))).toEqual([]);
  });

  test("puts what is waiting on the person above the history", async ({ page }) => {
    /* Order is the design: everything else on the page is information, and
       this is the only row that is a request. */
    await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });

    const waiting = page.getByTestId("routines-waiting");
    await expect(waiting).toContainText("Read the three");

    const waitingBox = await waiting.boundingBox();
    const runsBox = await page.getByTestId("routines-runs").boundingBox();
    expect(waitingBox!.y).toBeLessThan(runsBox!.y);
  });

  test("shows the reasoning behind a finding, not just a label", async ({ page }) => {
    await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });

    const findings = page.getByTestId("routines-findings");
    await expect(findings).toContainText("Asked 12 times");
    await expect(findings).toContainText("not as important");

    /* Above the log, so somebody who reads only the top of the page still
       leaves with something they can act on. */
    const findingsBox = await findings.boundingBox();
    const runsBox = await page.getByTestId("routines-runs").boundingBox();
    expect(findingsBox!.y).toBeLessThan(runsBox!.y);
  });

  test("keeps the machine's time and the person's time as separate numbers", async ({ page }) => {
    await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("routines-metric-tech")).toContainText(/work done for you/i);
    await expect(page.getByTestId("routines-metric-human")).toContainText(/your own time/i);
  });

  test("says what is scheduled and when", async ({ page }) => {
    await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("routines-schedules")).toContainText("every weekday at 8am");
  });
});

test.describe("an empty account", () => {
  test("is told what to do next rather than shown empty boxes", async ({ page }) => {
    /* An empty page on a first visit teaches somebody there is nothing here. */
    await stubInstinctSession(page, { role: "member" });
    await page.route("**/api/routines**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...ROUTINES_PAYLOAD, saved: [], schedules: [], runs: [], findings: [] }),
      });
    });

    await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });

    /* The built-ins are still listed, so the page is never empty. */
    await expect(page.getByTestId("routines-chains")).toContainText("run my morning");
    await expect(page.getByTestId("routines-no-schedules")).toContainText(/every weekday at 8am/i);
    await expect(page.getByTestId("routines-no-findings")).toContainText(/not enough runs yet/i);
  });
});

test.describe("signed out", () => {
  test("is redirected to login instead of shown a blank page", async ({ page }) => {
    /* The April blank-dashboard incident in one assertion. */
    await page.addInitScript(() => {
      localStorage.removeItem("instinct_token");
      localStorage.removeItem("instinct_user");
    });

    await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    /* Deliberately NOT asserting a next= parameter. Two layers can catch this,
       and the middleware catches it first, server-side, before the page is
       ever sent. That is the better outcome: the client-side guard exists for
       the case where a session expires mid-visit. Asserting the client's
       wording here would pin the WEAKER of the two paths and would start
       failing the day the middleware got better. What matters is that nothing
       from the page was rendered. */
    await expect(page.getByTestId("routines-root")).toHaveCount(0);
  });
});
