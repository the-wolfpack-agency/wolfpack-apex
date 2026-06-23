/**
 * Agent-principal onboarding reality check.
 *
 * Agent principals are AI actors the system treats as first-class users
 * (OGIAM, agents as teammates). The admin roster at /admin/agents is where an
 * operator sees the directory of those principals and onboards new ones. This
 * spec proves, at the layer the jest suite cannot reach, that the roster page
 * is wired to a real API against a real DB and renders cleanly in the browser.
 *
 * The class of bug this defends against: an /admin/agents page that 200s but
 * renders a blank widget (the kind a 401 or a missing testid would hide from
 * unit tests), or an onboard form that never mounts.
 *
 * Flow:
 *   1. Sign in. Skip cleanly when SMOKE creds are absent.
 *   2. Load /admin/agents: 200, not blank (contains "Agents"), the roster OR
 *      the empty-state testid renders, and ZERO CSP/network failures over a 3s
 *      idle window.
 *   3. Assert the onboard form + role select are present.
 *
 * Best-effort and non-destructive: it never POSTs a real agent so prod data is
 * not polluted; it only asserts the page and form render.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL. Skips
 * cleanly (does not fail CI) when creds are missing.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Agent-principal onboarding, roster reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/agents renders the roster-or-empty state and the onboard form cleanly", async ({
    page,
  }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/agents`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/agents loads (not 401/blank)").toBe(200);

    // The page is not blank: the title is rendered.
    const bodyText = (
      await page.locator("body").innerText().catch(() => "")
    ).toLowerCase();
    expect(bodyText.includes("agents"), "the agents page is not blank").toBe(true);

    // Either the roster list or the explicit empty state is in the DOM, never a
    // silent blank. One of the two testids is always present.
    const roster = page.getByTestId("agents-roster");
    const empty = page.getByTestId("agents-empty");
    const rosterCount = await roster.count();
    const emptyCount = await empty.count();
    expect(
      rosterCount + emptyCount,
      "the roster list or the empty-state testid is rendered",
    ).toBeGreaterThan(0);

    // The onboard form and its role select mount. We do NOT submit it: creating
    // an agent in prod would pollute real data, so this is render-only.
    await expect(
      page.getByTestId("agent-onboard-form"),
      "the onboard form is present",
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByTestId("agent-onboard-role"),
      "the role select is present",
    ).toBeVisible();

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/agents:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("/admin/agents/memory renders the shared-memory list-or-empty state cleanly", async ({
    page,
  }) => {
    // The shared agent-memory view is what one agent learns and another
    // inherits: promoted procedures are reusable, quarantined ones wait for the
    // safety check. This is a render-only reality check: it never promotes or
    // rejects (no overrides in e2e), so prod memory is not mutated.
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/agents/memory`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/agents/memory loads (not 401/blank)").toBe(200);

    // The page is not blank: the title is rendered.
    const bodyText = (
      await page.locator("body").innerText().catch(() => "")
    ).toLowerCase();
    expect(
      bodyText.includes("agent memory"),
      "the agent-memory page is not blank",
    ).toBe(true);

    // Either the memory list or the explicit empty state is in the DOM, never a
    // silent blank. One of the two testids is always present.
    const list = page.getByTestId("memory-list");
    const empty = page.getByTestId("memory-empty");
    const listCount = await list.count();
    const emptyCount = await empty.count();
    expect(
      listCount + emptyCount,
      "the memory list or the empty-state testid is rendered",
    ).toBeGreaterThan(0);

    // The status filter mounts so an operator can scope to promoted/quarantined.
    await expect(
      page.getByTestId("memory-filter"),
      "the status filter is present",
    ).toBeVisible({ timeout: 8_000 });

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/agents/memory:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("an agent profile, when one exists, renders its system-model scan section cleanly", async ({
    page,
  }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/agents`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/agents loads (not 401/blank)").toBe(200);

    // Find the first profile link in the roster. When the roster is empty
    // (the empty-state testid is showing), there is no profile to visit, so we
    // skip cleanly: this is render-only and must never pollute prod data.
    const profileLink = page.locator('a[href^="/admin/agents/"]').first();
    if ((await profileLink.count()) === 0) {
      test.skip(true, "no agents in the roster to open a profile for");
      return;
    }

    await profileLink.click();
    await page.waitForLoadState("domcontentloaded");

    // The profile mounts (not a 401 blank) and the system-model section is
    // present. The scan is agent-initiated, so the section renders either the
    // learned-tools summary or the calm "has not run its onboarding scan yet"
    // empty state, never a silent blank.
    await expect(
      page.getByTestId("admin-agent-page"),
      "the agent profile page mounts",
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByTestId("agent-scan-section"),
      "the system-model scan section is present",
    ).toBeVisible({ timeout: 8_000 });

    // The bridge to the agent-filtered OGIAM explorer is present.
    await expect(
      page.getByTestId("agent-activity-link"),
      "the gated-actions link is present",
    ).toBeVisible();

    // No CSP or network failures during the idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on the agent profile:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
