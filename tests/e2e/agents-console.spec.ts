/**
 * Agent fleet command-center reality check (/admin/agents).
 *
 * The agents list is the operator-facing AGENT FLEET console: a fleet-overview
 * metric row (total / active / paused / invited / connected) plus the roster as
 * a card grid, each card a StatusPill + a link into /admin/agents/[id]. This
 * spec proves, at the layer the jest suite cannot reach, that the redesigned
 * page is wired to a real API against a real DB and renders cleanly in the
 * browser.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * widget (a 401 or missing testid the unit tests can't see), or a console that
 * blanks instead of redirecting an unauthenticated visitor.
 *
 * Two paths (mirrors benchmark-dashboard.spec.ts):
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and EITHER
 *      the fleet metrics + agent cards render OR the explicit empty state
 *      renders, with ZERO CSP/network failures over a 3s idle window.
 *
 * Auth-helper limitation: this repo's e2e session helper (signInIfPossible) is
 * credential-based and gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against
 * PROD_URL. When those are absent, the authenticated path skips cleanly (does
 * not fail CI); the unauth-redirect path always runs.
 *
 * Best-effort and non-destructive: it never onboards an agent (no POST), so the
 * roster is not polluted; it only asserts the page renders.
 */

import { test, expect } from "@playwright/test";
import {
  expectRendered,
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Agent fleet console reality check", () => {
  test("unauthenticated visit to /admin/agents redirects to /login (never blank)", async ({
    page,
  }) => {
    // No session seeded: the page's auth-redirect guard must send the visitor
    // to /login with a ?next back to the console, not render an empty surface.
    await page.goto(`${target.baseUrl}/admin/agents`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);

    expect(
      page.url().includes("/login"),
      "unauthenticated /admin/agents lands on /login, not a blank console",
    ).toBe(true);
  });

  test("authenticated /admin/agents renders the fleet metrics + roster OR the empty state cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds: authenticated agents path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/agents`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/agents loads (not 401/blank)").toBe(200);

    // The page is not blank: the fleet framing copy is rendered.
    await expectRendered(page, "/admin/agents", ["agent"], {
      message: "the agents console is not blank",
    });

    // The page-level container always mounts.
    await expect(
      page.getByTestId("admin-agents-page"),
      "the agents console container mounts",
    ).toBeVisible({ timeout: 8_000 });

    // The fleet-overview metric row always renders (counts of 0 are still a
    // rendered tile, never a blank), and the total tile is present.
    await expect(
      page.getByTestId("agents-fleet-metrics"),
      "the fleet-overview metric row renders",
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByTestId("fleet-metric-total"),
      "the total-agents metric tile renders",
    ).toBeVisible();

    // Either the roster card grid OR the explicit empty state is in the DOM,
    // never a silent blank. The onboard form is always present.
    await expect(
      page.getByTestId("agent-onboard-form"),
      "the onboard form renders",
    ).toBeVisible();

    const roster = page.getByTestId("agents-roster-grid");
    const empty = page.getByTestId("agents-empty");
    const rosterCount = await roster.count();
    const emptyCount = await empty.count();
    expect(
      rosterCount + emptyCount,
      "the roster grid or the explicit empty-state testid is rendered",
    ).toBeGreaterThan(0);

    if (rosterCount > 0) {
      // At least one agent card renders, with a status pill and a detail link.
      const firstCard = roster.locator('[data-testid^="agent-row-"]').first();
      await expect(firstCard, "an agent card renders").toBeVisible();
      const href = await firstCard.getAttribute("href");
      expect(
        href && href.startsWith("/admin/agents/"),
        "the agent card links into its per-agent detail page",
      ).toBe(true);
    } else {
      await expect(empty, "the empty state explains how to onboard an agent").toContainText(
        /no agent principals yet/i,
      );
    }

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/agents:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);

    // ---- MOBILE viewport pass (390x844, iPhone-class) ----
    // The fleet nav row (Write approvals / Platform scans / Connections /
    // Shared memory + Refresh) overflowed the right edge on a narrow viewport.
    // Reload at a phone width and assert NO horizontal overflow anywhere and
    // that the nav controls sit within the viewport. SMOKE-creds gated (this is
    // inside the authenticated block, which skips cleanly without creds).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${target.baseUrl}/admin/agents`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await expect(
      page.getByTestId("admin-agents-page"),
      "the agents console mounts at a phone width",
    ).toBeVisible({ timeout: 8_000 });

    // No horizontal scroll: the document content fits the viewport (2px slack
    // for sub-pixel rounding).
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        (window.innerWidth || document.documentElement.clientWidth),
    );
    expect(
      overflow,
      `no horizontal overflow on /admin/agents at 390px (overflow=${overflow}px)`,
    ).toBeLessThanOrEqual(2);

    // The nav buttons are within the viewport: every nav control's right edge is
    // at or inside the viewport width.
    const navTestIds = [
      "agents-approvals-link",
      "agents-platform-scans-link",
      "agents-connectors-link",
      "agents-memory-link",
    ];
    for (const testId of navTestIds) {
      const box = await page.getByTestId(testId).boundingBox();
      if (box) {
        expect(
          box.x + box.width,
          `${testId} fits within the 390px viewport (right edge=${box.x + box.width}px)`,
        ).toBeLessThanOrEqual(392);
      }
    }
  });
});
