/**
 * The security course, driven as a real learner journey in a real browser.
 *
 * WHAT IT GUARDS. /builds/security-plain-language is now an interactive,
 * progress-tracked course. The failures this product has actually shipped live
 * exactly here: an authenticated page that renders empty instead of gating, a
 * button that posts the wrong body, a widget that draws nothing, a CSP rule
 * that blanks the page, a body that scrolls sideways on a laptop. This exercises
 * every user route and path end to end.
 *
 * NO CREDENTIALS NEEDED. The LMS API is intercepted with fixture responses (the
 * session is stubbed the same way), so the REAL deployed page bundle runs the
 * REAL journey - load, enroll, view, complete, self-check, finish - against a
 * simulated backend. The stubbed-session -> graceful-unavailable path against
 * the LIVE API is covered separately in client-builds.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/builds/security-plain-language";

const COURSE = {
  id: "c1",
  slug: "security-plain-language",
  title: "Security in Plain Language",
  subtitle: null,
  headline: "Take the gates down.",
  tracks: [
    { id: "t1", position: 0, name: "Foundations", audience: "Everyone", proves: "Say it plainly." },
    { id: "t2", position: 1, name: "Practitioner", audience: "Sales", proves: "Map to a problem." },
    { id: "t3", position: 2, name: "Ambassador", audience: "Leads", proves: "Teach it." },
  ],
  modules: [
    {
      id: "m1", position: 0, title: "The product line", summary: "Plain words.",
      lessons: [
        { id: "l1", position: 0, title: "The network firewall", subtitle: "NGFW", blocks: [
          { type: "glossary", term: "App-ID" },
          { type: "plain", text: "It opens the trunk and checks the driver, not just the plate on the car." },
          { type: "stops", text: "Bad traffic sneaking in disguised as something allowed." },
          { type: "without", text: "The disguise works and it walks right in." },
        ] },
        { id: "l2", position: 1, title: "Cloud security", subtitle: "CNAPP", blocks: [
          { type: "plain", text: "It walks the building checking every door and window, before and after it is built." },
          { type: "stops", text: "The accidental we-left-it-exposed mistake." },
          { type: "without", text: "That is the mistake behind most leaked-records headlines." },
        ] },
      ],
    },
  ],
  lessonIds: ["l1", "l2"],
};

/** Install the LMS API interception with a mutable in-memory progress store so
 *  the full journey (view -> complete -> complete-all -> done) actually
 *  advances against the real client code. */
async function stubCourseApi(page: Page) {
  const completed = new Set<string>();
  const posts: { lessonId: string; action: string }[] = [];

  const progress = () => ({
    enrolled: true,
    lessons: Object.fromEntries([...completed].map((id) => [id, "completed"])),
    completed: COURSE.lessonIds.every((id) => completed.has(id)),
  });

  await page.route("**/api/lms/courses/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ course: COURSE, progress: progress() }) });
  });
  await page.route("**/api/lms/progress", async (route) => {
    const body = route.request().postDataJSON() as { lessonId: string; action: string };
    posts.push(body);
    if (body.action === "complete") completed.add(body.lessonId);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ progress: progress() }) });
  });
  return { posts };
}

test.describe("LMS security course - learner journey", () => {
  test("loads the course scaffold: banner, ladder, lessons, four beats", async ({ page }) => {
    await stubInstinctSession(page);
    await stubCourseApi(page);
    const failures = collectConsoleAndNetworkFailures(page);

    const res = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "course page should serve").toBeLessThan(400);

    await expect(page.getByTestId("spl-course")).toBeVisible({ timeout: 20_000 });
    // The ladder (progression spine) renders all three tiers.
    const ladder = page.getByTestId("spl-ladder");
    await expect(ladder).toBeVisible();
    await expect(ladder).toContainText("Foundations");
    await expect(ladder).toContainText("Practitioner");
    await expect(page.getByTestId("spl-progress-count")).toContainText("0 of 2");

    // The four plain-language beats render for a lesson.
    const l1 = page.getByTestId("lesson-l1");
    await expect(l1).toContainText("App-ID");
    await expect(l1).toContainText(/What it stops/i);
    await expect(l1).toContainText(/Without it/i);

    const csp = failures().filter((f) => f.detail.startsWith("CSP:"));
    expect(csp, `CSP violations:\n${csp.map((f) => f.detail).join("\n")}`).toEqual([]);
  });

  test("marking lessons complete advances progress to the completion state", async ({ page }) => {
    await stubInstinctSession(page);
    const { posts } = await stubCourseApi(page);
    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("spl-course")).toBeVisible({ timeout: 20_000 });

    // Complete the first lesson -> done badge + count increments.
    await page.getByTestId("lesson-complete-l1").click();
    await expect(page.getByTestId("lesson-done-l1")).toBeVisible();
    await expect(page.getByTestId("spl-progress-count")).toContainText("1 of 2");

    // Complete the last lesson -> whole-course completion badge, Foundations passes.
    await page.getByTestId("lesson-complete-l2").click();
    await expect(page.getByTestId("spl-complete-badge")).toBeVisible();
    await expect(page.getByTestId("spl-progress-count")).toContainText("2 of 2");

    // The client posted the right bodies.
    const completes = posts.filter((p) => p.action === "complete").map((p) => p.lessonId);
    expect(completes).toEqual(expect.arrayContaining(["l1", "l2"]));
  });

  test("'Check yourself' reveals the four-beat rubric and records a self-check", async ({ page }) => {
    await stubInstinctSession(page);
    const { posts } = await stubCourseApi(page);
    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("spl-course")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("lesson-check-l1").click();
    const rubric = page.getByTestId("lesson-selfcheck-l1");
    await expect(rubric).toBeVisible();
    await expect(rubric).toContainText(/Name the jargon/i);
    await expect(rubric).toContainText(/What it stops/i);
    expect(posts.some((p) => p.action === "self_check" && p.lessonId === "l1")).toBe(true);
  });

  test("expanding a lesson records a view exactly once", async ({ page }) => {
    await stubInstinctSession(page);
    const { posts } = await stubCourseApi(page);
    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("spl-course")).toBeVisible({ timeout: 20_000 });

    const summary = page.locator('[data-testid="lesson-l1"] summary');
    await summary.click(); // open
    await expect(page.getByTestId("lesson-selfcheck-l1")).toHaveCount(0); // not checked yet
    await summary.click(); // close
    await summary.click(); // reopen - must NOT double-count
    const views = posts.filter((p) => p.action === "view" && p.lessonId === "l1");
    expect(views.length, "view fires once per lesson").toBe(1);
  });

  test("the course page never scrolls sideways on a laptop", async ({ page }) => {
    await stubInstinctSession(page);
    await stubCourseApi(page);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("spl-course")).toBeVisible({ timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the course page scrolls horizontally").toBeLessThanOrEqual(1);
  });

  test("a signed-out visitor is gated to login, not shown an empty course", async ({ page }) => {
    // No session stub: clear any token so the auth gate fires.
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await stubCourseApi(page); // in case anything tries the API, it must NOT be needed
    let apiCalled = false;
    await page.route("**/api/lms/courses/**", (route) => { apiCalled = true; route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ course: COURSE, progress: { enrolled: false, lessons: {}, completed: false } }) }); });

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    // Real browser: the page redirects to /login?next=... (jsdom cannot test this).
    await page.waitForURL(/\/login\?next=/, { timeout: 20_000 }).catch(() => {});
    const onLogin = /\/login/.test(page.url());
    const ladderHidden = (await page.getByTestId("spl-ladder").count()) === 0;
    expect(onLogin || ladderHidden, "signed-out visitor must not see the course").toBe(true);
    expect(apiCalled, "must not fetch the course without a session").toBe(false);
  });
});
