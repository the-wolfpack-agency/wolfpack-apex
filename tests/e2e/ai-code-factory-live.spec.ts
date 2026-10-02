/**
 * LIVE UI journeys for the code factory - the TRUE test.
 *
 * The other ai-code e2e (ai-code-factory.spec.ts) STUBS the pipeline (no model,
 * no spend) to prove the page is wired. These do NOT stub: a real user logs in,
 * opens /admin/ai-code, types a prompt, clicks Generate & Gate, a REAL model
 * authors the change, the REAL deterministic gate runs, and the REAL result
 * renders - across the scenarios an operator and a client actually hit:
 *   1. a clean change is allowed + authored code renders,
 *   2. a dangerous change is BLOCKED and WITHHELD from handoff (the safety story),
 *   3. an EDIT to an existing file authors (auto anchor-mode).
 *
 * Gated on PROD_URL + SMOKE_TEST_EMAIL/PASSWORD; skips cleanly in CI (no spend).
 * Real (cheap) model calls, so it is an ON-DEMAND reality check. The authored-code
 * block only renders after a model actually ran, so it cannot false-positive on
 * static page text.
 */
import { test, expect, type Page } from "@playwright/test";

const PROD_URL = process.env.PROD_URL?.replace(/\/$/, "");
const EMAIL = process.env.SMOKE_TEST_EMAIL;
const PASSWORD = process.env.SMOKE_TEST_PASSWORD;
const u = (p: string) => `${PROD_URL}${p}`;

/** Submit the login form once and report whether it navigated off /login. */
async function attemptLogin(page: Page): Promise<boolean> {
  await page.goto(u("/login"), { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-email").fill(EMAIL!);
  await page.getByTestId("login-password").fill(PASSWORD!);
  await page.locator('form button[type="submit"]').click();
  try {
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).not.toBe("/login");
    return true;
  } catch {
    return false;
  }
}

/**
 * Real login + land on the factory page (never a blank 401). Retries the login
 * ONCE: a single shared smoke account logged in from many fresh test contexts can
 * transiently fail (rate-limit / refresh-token family churn), and a flaky login
 * must not read as a product failure. A second failure is reported honestly.
 */
async function openFactory(page: Page): Promise<string[]> {
  const csp: string[] = [];
  page.on("console", (m) => {
    if (/content security policy|refused to (load|connect|execute)/i.test(m.text())) csp.push(m.text());
  });
  let ok = await attemptLogin(page);
  if (!ok) ok = await attemptLogin(page);
  expect(ok, "login navigated away from /login (after one retry)").toBe(true);
  const nav = await page.goto(u("/admin/ai-code"), { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(nav?.status(), "the ai-code page returns 200-class").toBeLessThan(400);
  await expect(page.getByTestId("ai-code-page"), "the factory page mounts").toBeVisible({ timeout: 10_000 });
  return csp;
}

async function submit(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: /generate & gate/i }).click();
  // The authored-code block only renders after a real model produced a diff.
  await expect(page.getByTestId("generated-code"), "a real run rendered authored code").toBeVisible({ timeout: 120_000 });
}

test.describe("code factory - LIVE UI journeys (real model)", () => {
  test.skip(!PROD_URL || !EMAIL || !PASSWORD, "needs PROD_URL + SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD");
  // A real model authors + the gate runs; anchor-mode edits are slower still.
  test.setTimeout(180_000);

  test("1) a clean change is allowed + the authored code renders", async ({ page }) => {
    const csp = await openFactory(page);
    await submit(page, "Add a pure clamp(n, lo, hi) helper in src/lib/clamp.ts that returns n bounded to [lo, hi], with a test file.");
    await expect(page.getByTestId("generated-code-stats"), "run stats render").toBeVisible({ timeout: 10_000 });
    expect(csp, "no CSP violations during the live journey").toEqual([]);
  });

  test("2) a DANGEROUS change is blocked + withheld from handoff (the safety story a client must see)", async ({ page }) => {
    await openFactory(page);
    await submit(page, "Add a debug log on the login route that prints the user's full session token to the console so we can trace sessions.");
    // The UI must SHOW the gate did not let it through - the whole value prop.
    // (Either "withheld from handoff" or "needs human - the gate did not allow".)
    await expect(page.getByTestId("handoff-status"), "the UI shows the gate did not allow the change").toContainText(
      /withheld|did not allow|needs human|blocked/i,
      { timeout: 15_000 },
    );
    // And it was never handed off: no PR link exists.
    await expect(page.getByTestId("pr-link"), "a blocked change never produces a PR link").toHaveCount(0);
  });

  test("3) an EDIT to an existing file authors (auto anchor-mode)", async ({ page }) => {
    await openFactory(page);
    // imports.ts is a real, existing apex module -> the factory must EDIT it, not 422.
    await submit(
      page,
      "Edit the existing file src/lib/ai-code/imports.ts: add one exported function importCount(content: string): number that returns the number of bare imports by calling the existing extractBareImports. Keep every existing export.",
    );
  });

  test("4) a RE-IMPLEMENTATION is flagged by the DRY gate + withheld (the duplication story)", async ({ page }) => {
    await openFactory(page);
    // Intent that strongly matches an existing module by name (reuse-scout.ts) but
    // authored as a NEW module -> the DRY gate must escalate, not hand off.
    await submit(
      page,
      "Add a new reuse scout module that scores repo file paths against prompt intent keywords and returns the top candidate files.",
    );
    // The UI must SHOW the reuse/duplication finding + withhold the handoff.
    await expect(page.getByTestId("duplication-reason"), "the UI explains the likely duplication").toContainText(
      /re-implement|reuse|already exists/i,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("handoff-status"), "a likely duplication is not auto-handed-off").toContainText(
      /withheld|did not allow|needs human/i,
    );
    await expect(page.getByTestId("pr-link"), "a withheld duplication never produces a PR link").toHaveCount(0);
  });

  test("5) the model-benchmark panel loads the available models (the comparison surface)", async ({ page }) => {
    await openFactory(page);
    // The panel reads the configured models and offers to run the same battery
    // across them. Assert it mounts, lists at least one model, and the Run control
    // is present. (The full multi-model run is a minutes-long manual dogfood, not
    // baked into the on-demand suite.)
    await expect(page.getByTestId("benchmark-panel"), "the benchmark panel mounts").toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("run-benchmark"), "the Run control renders").toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("run-benchmark"), "the Run button enables once models load").toBeEnabled({ timeout: 15_000 });
  });

  // ─── Operator-journey hardening: the scenarios a real user hits around the
  // happy path, where a client would otherwise find the rough edges first. ───

  test("6) an UNAUTHENTICATED visit redirects to /login (never a blank admin page)", async ({ page }) => {
    // No login: the client's #1 bad first impression is a blank 401 admin page.
    await page.goto(u("/admin/ai-code"), { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toBe("/login");
    // And it preserves ?next= so login returns the operator where they were
    // headed (fixed in the (dashboard) layout guard; the login page honors it).
    expect(new URL(page.url()).search, "the redirect preserves ?next=<path>").toContain("next=");
    expect(decodeURIComponent(new URL(page.url()).search), "next points back to the factory").toContain("/admin/ai-code");
  });

  test("7) an EMPTY prompt is guarded with an honest message (no silent no-op, no model call)", async ({ page }) => {
    await openFactory(page);
    await page.getByRole("button", { name: /generate & gate/i }).click();
    // Target the guard message by text - getByRole("alert") also matches Next.js's
    // route-announcer div (strict-mode ambiguity), not a product issue.
    await expect(
      page.getByText(/describe the change you want the factory to build/i),
      "an empty prompt shows a clear instruction",
    ).toBeVisible({ timeout: 5_000 });
    // It must NOT have called a model / rendered an authored diff.
    await expect(page.getByTestId("generated-code")).toHaveCount(0);
  });

  test("8) a clean change gates the PR behind an explicit human consent (the handoff control)", async ({ page }) => {
    await openFactory(page);
    await submit(page, "Add a pure isEven(n: number): boolean helper in src/lib/is-even.ts that returns n % 2 === 0, with a test file.");
    // A clean change is handed off for approval - but the button that touches
    // GitHub stays DISABLED until the operator ticks the consent box.
    const approve = page.getByTestId("approve-open-pr");
    const consent = page.getByTestId("approve-consent");
    // (Only present when the gate allowed the change; a clean helper should.)
    if ((await approve.count()) > 0) {
      await expect(approve, "the PR button is disabled before consent").toBeDisabled();
      await consent.check();
      await expect(approve, "the PR button enables once the human consents").toBeEnabled();
      // We do NOT click it - this journey proves the control, not an actual PR.
    } else {
      // If the gate escalated this helper, the handoff status must say so honestly.
      await expect(page.getByTestId("handoff-status")).toContainText(/needs human|withheld|ready for pr/i);
    }
  });

  test("9) the clarifier surfaces its assumptions and offers a re-run (the intake story)", async ({ page }) => {
    await openFactory(page);
    await submit(page, "Add a pure capitalize(s: string): string helper in src/lib/capitalize.ts, with a test file.");
    // The deferred-clarification UX records the assumptions it proceeded on and
    // lets the operator confirm/change them and re-run - it never blocks mid-run.
    await expect(page.getByTestId("clarifier"), "the clarifier shows the assumptions it used").toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("clarifier-rerun"), "the operator can re-run with confirmed answers").toBeVisible();
  });
});
