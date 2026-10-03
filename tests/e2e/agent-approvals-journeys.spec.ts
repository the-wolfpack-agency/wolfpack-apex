/**
 * Agent Approvals - LIVE client journeys (/admin/agents/approvals).
 *
 * The human-in-the-loop surface: an agent proposes a write, it waits here, and a
 * human approves (runs the exact captured action as the owner, re-gated + audited)
 * or rejects. This drives the DEPLOYED inbox through the journeys a client runs:
 * an unauthenticated visit bounces to /login; signed in, the inbox loads 200 (never
 * a blank 401), resolves to a real terminal state (a populated list, an honest
 * empty state, or an explicit error - never a spinner), and when writes are pending
 * the approve + reject controls actually render and are actionable.
 *
 * SAFETY: it deliberately does NOT click approve/reject. Approving executes a REAL
 * write (opens a real PR, writes a real CRM record) and rejecting drops a real
 * pending write - both mutate production. So, exactly like the factory's no-click
 * consent scenario, this proves the controls are present + enabled without firing
 * a destructive action against live data. The approve->execute->audit LOGIC is
 * covered by the route contract tests; the factory's approve->PR path is proven
 * live by the full-journey dogfood on the throwaway repo.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL; skips locally
 * when unset, FAILS LOUDLY in CI (never skip-green).
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

async function openApprovals(page: Page): Promise<() => { kind: string; detail: string }[]> {
  const snapshot = collectConsoleAndNetworkFailures(page);
  const nav = await page.goto(`${target.baseUrl}/admin/agents/approvals`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(nav?.status(), "/admin/agents/approvals loads (not 401/blank)").toBe(200);
  await expect(page.getByTestId("agent-approvals-page"), "the approvals inbox shell mounts").toBeVisible({ timeout: 15_000 });
  return snapshot;
}

test.describe("Agent Approvals - LIVE client journeys", () => {
  test("1) an unauthenticated visit redirects to /login (never a blank admin page)", async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${target.baseUrl}/admin/agents/approvals`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/login");
    } finally {
      await ctx.close();
    }
  });

  test.describe("signed in", () => {
    test.beforeEach(async ({ page }) => {
      const signedIn = await signInIfPossible(page, target);
      if (!signedIn) {
        if (process.env.CI === "true") {
          throw new Error("CI misconfiguration: the Agent Approvals dogfood needs a working SMOKE_TEST_EMAIL/PASSWORD login against PROD_URL.");
        }
        test.skip();
      }
    });

    test("2) the inbox resolves to a real terminal state (list OR honest empty OR error), no console/network failures", async ({ page }) => {
      const snapshot = await openApprovals(page);
      const list = page.getByTestId("approvals-list");
      const empty = page.getByTestId("approvals-empty");
      const error = page.getByTestId("approvals-error");
      await expect(list.or(empty).or(error).first(), "the inbox renders a terminal state, not a spinner").toBeVisible({ timeout: 15_000 });
      // An error state is a real failure to load the inbox - fail loudly.
      expect(await error.count(), "the inbox loaded without an error state").toBe(0);
      const failures = snapshot();
      expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
    });

    test("3) pending writes expose actionable approve + reject controls (asserted, never clicked)", async ({ page }) => {
      await openApprovals(page);
      const empty = page.getByTestId("approvals-empty");
      if ((await empty.count()) > 0) {
        await expect(empty, "an empty inbox shows the honest empty state, not a blank").toContainText(/no pending|nothing is awaiting/i);
        return;
      }
      // Populated: the human-in-the-loop controls must render + be enabled, so a
      // human CAN act. We never click - approve/reject mutate production.
      const approve = page.locator('[data-testid^="approve-"]').first();
      const reject = page.locator('[data-testid^="reject-"]').first();
      await expect(approve, "an approve control renders for a pending write").toBeVisible({ timeout: 10_000 });
      await expect(reject, "a reject control renders for a pending write").toBeVisible();
      await expect(approve, "approve is actionable").toBeEnabled();
    });
  });
});
