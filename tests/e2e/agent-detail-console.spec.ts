/**
 * Agent detail command-view reality check (/admin/agents/[id]).
 *
 * The single-agent command view is the trust surface a client reaches from the
 * fleet list: the agent's identity, its governed decisions, the metric tiles,
 * and the audit trail. This spec proves, at the layer the jest suite cannot
 * reach, that the redesigned page is wired to real APIs against a real DB and
 * renders cleanly in the browser (dark-glass kit, count-up tiles, audit
 * timeline) rather than 200-ing into a blank command view.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * widget (a 401 or missing testid the unit tests can't see), or a detail page
 * that blanks instead of redirecting an unauthenticated visitor.
 *
 * Two paths:
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and EITHER
 *      the identity header + metrics (+ the decision/audit timeline) render OR
 *      the explicit not-found state renders, with ZERO CSP/network failures
 *      over a 3s idle window.
 *
 * Auth-helper limitation mirrors benchmark-dashboard.spec.ts: signInIfPossible
 * is credential-based and gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD
 * against PROD_URL. When those are absent the authenticated path skips cleanly
 * (does not fail CI); the unauth-redirect path always runs.
 *
 * Best-effort and non-destructive: it never assigns work, runs a scan, or fires
 * a drift check (no POST), so prod agent data is not polluted; it only asserts
 * the page renders.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

// The live example agent the redesign was built against (the detail page reached
// from the fleet list). An authed load resolves to either this agent's command
// view or, if it has been offboarded, the explicit not-found state.
const AGENT_ID = "012693d6-9473-411c-a98c-27e501c4a9ec";
const AGENT_PATH = `/admin/agents/${AGENT_ID}`;

test.describe("Agent detail command-view reality check", () => {
  test("unauthenticated visit to the agent detail redirects to /login (never blank)", async ({
    page,
  }) => {
    // No session seeded: the page's auth-redirect guard must send the visitor to
    // /login with a ?next back to this agent, not render an empty command view.
    await page.goto(`${target.baseUrl}${AGENT_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);

    expect(
      page.url().includes("/login"),
      "unauthenticated agent detail lands on /login, not a blank command view",
    ).toBe(true);
  });

  test("authenticated agent detail renders identity + metrics + timeline OR the not-found state cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds: authenticated agent-detail path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}${AGENT_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "agent detail loads (not 401/blank)").toBe(200);

    // The page-level container is always present, whatever the agent's state.
    await expect(
      page.getByTestId("admin-agent-page"),
      "the agent detail page container mounts",
    ).toBeVisible({ timeout: 8_000 });

    // Either the live agent's command view OR the explicit not-found state is in
    // the DOM, never a silent blank.
    const identity = page.getByTestId("agent-name");
    const notFound = page.getByTestId("agent-not-found");
    const identityCount = await identity.count();
    const notFoundCount = await notFound.count();
    expect(
      identityCount + notFoundCount,
      "the identity header or the explicit not-found state is rendered",
    ).toBeGreaterThan(0);

    if (identityCount > 0) {
      // The redesigned identity header: name, the id in a monospace block, and a
      // status pill all render with non-zero content.
      await expect(page.getByTestId("agent-name"), "the agent name renders").toBeVisible();
      await expect(
        page.getByTestId("agent-id-mono"),
        "the agent id renders in the monospace header block",
      ).toContainText(AGENT_ID);
      await expect(
        page.getByTestId("agent-state-chip"),
        "the agent status pill renders",
      ).toBeVisible();

      // The hero metric tiles render (the trust surface a client scans first).
      await expect(
        page.getByTestId("agent-metrics-panel"),
        "the command metrics panel renders",
      ).toBeVisible();
      await expect(
        page.getByTestId("metric-decisions"),
        "the recent-decisions metric tile renders",
      ).toBeVisible();
      await expect(
        page.getByTestId("metric-enforcement"),
        "the gate-enforcement metric tile renders",
      ).toBeVisible();

      // The decision/audit timeline (the trust surface) is on the Activity tab.
      // Switch to it, then assert the audit section renders EITHER rows OR its
      // explicit empty state, never a blank panel.
      await page.getByTestId("agent-tab-activity").click();
      await expect(
        page.getByTestId("agent-log-section"),
        "the agent log (audit timeline) section renders",
      ).toBeVisible({ timeout: 8_000 });
      const logList = page.getByTestId("agent-log-list");
      const logEmpty = page.getByTestId("agent-log-empty");
      const logError = page.getByTestId("agent-log-error");
      expect(
        (await logList.count()) + (await logEmpty.count()) + (await logError.count()),
        "the audit timeline shows rows, the empty state, or a quiet error (never blank)",
      ).toBeGreaterThan(0);
    } else {
      // A removed/offboarded agent spells out the not-found state, never a blank.
      await expect(notFound, "the not-found state names the missing agent").toContainText(
        new RegExp(AGENT_ID, "i"),
      );
    }

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on ${AGENT_PATH}:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);

    // ---- MOBILE viewport pass (390x844, iPhone-class) ----
    // Two redesign bugs this defends against on a narrow viewport: the action
    // buttons (Pause / Revoke) overflowing the right edge, and the metrics row
    // (Gate enforcement / Assigned runs / Last active) being occluded behind a
    // mis-offset page-level sticky header. Reload at a phone width and assert NO
    // horizontal overflow and that the lifecycle buttons sit within the
    // viewport. SMOKE-creds gated (inside the authenticated block; skips cleanly
    // without creds).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${target.baseUrl}${AGENT_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await expect(
      page.getByTestId("admin-agent-page"),
      "the agent detail page mounts at a phone width",
    ).toBeVisible({ timeout: 8_000 });

    // Only assert the action layout on a live agent (not the not-found state).
    if ((await page.getByTestId("agent-name").count()) > 0) {
      // No horizontal scroll: content fits the viewport (2px sub-pixel slack).
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          (window.innerWidth || document.documentElement.clientWidth),
      );
      expect(
        overflow,
        `no horizontal overflow on ${AGENT_PATH} at 390px (overflow=${overflow}px)`,
      ).toBeLessThanOrEqual(2);

      // The metrics row renders (not occluded behind a sticky header).
      await expect(
        page.getByTestId("agent-metrics-panel"),
        "the metrics row renders at a phone width (not hidden behind a sticky header)",
      ).toBeVisible();

      // Whichever lifecycle action buttons are present for the agent's current
      // state sit within the viewport (no right-edge clip).
      for (const testId of ["agent-pause", "agent-resume", "agent-revoke"]) {
        const control = page.getByTestId(testId);
        if ((await control.count()) > 0) {
          const box = await control.boundingBox();
          if (box) {
            expect(
              box.x + box.width,
              `${testId} fits within the 390px viewport (right edge=${box.x + box.width}px)`,
            ).toBeLessThanOrEqual(392);
          }
        }
      }
    }
  });
});
