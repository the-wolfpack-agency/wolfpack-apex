/**
 * Code factory reality check (/admin/ai-code).
 *
 * The page is the input-to-output surface of the factory: submit a PROMPT, a
 * model authors the change, the deterministic gate decides, and the verdict +
 * executor + (optional) independent judge render. This spec proves, at the layer
 * the jest suite cannot reach, that the redesigned page is wired to the pipeline
 * endpoint and renders cleanly in a real browser - the class of bug it defends
 * against is a page that 200s but blanks (a 401 the unit test can't see, a CSP
 * violation), or one that silently swallows the executor/verdict.
 *
 * Two paths (mirrors agents-console.spec.ts):
 *   1. Unauthenticated visit -> redirected to /login (never a blank). Always runs.
 *   2. Stubbed session + a STUBBED pipeline response (no real model call, no
 *      creds, no spend) -> submit a prompt, and the executor + gate verdict +
 *      ready-for-PR status render, with ZERO CSP/network failures.
 *
 * The pipeline response is stubbed on purpose: the endpoint calls paid models,
 * and its behavior is covered by the route contract test. Here we assert the UI
 * wiring, which is what the browser layer uniquely proves.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

const PIPELINE_RESPONSE = {
  run: {
    ref: "factory",
    status: "ready_for_pr",
    diff: "diff --git a/src/lib/strings.ts b/src/lib/strings.ts\n--- /dev/null\n+++ b/src/lib/strings.ts\n@@ -0,0 +1 @@\n+export const isPalindrome = (s) => s === [...s].reverse().join('');",
    review: {
      ref: "factory",
      author: "gpt-4o-mini",
      findings: [],
      verdict: { outcome: "allow", highestSeverity: "none", reason: "no security findings in the authored change", ruleId: "C-CLEAN-ALLOW" },
      bySeverity: {},
    },
    remediation: { status: "clean", attempts: [], repairerLineage: null, reason: "ok" },
    conformance: { conforms: true, findings: [] },
    openQuestions: [],
  },
  approvalId: "appr-e2e-1",
  executor: { diff: "diff --git a/src/lib/strings.ts b/src/lib/strings.ts", author: "gpt-4o-mini", provider: "azure-openai", costUsd: 0.00029, latencyMs: 820, error: null },
  invariants: { ruleId: "R-MUTATION-ALLOW", intendedOutcome: "allow", wouldBlock: false, reason: "ok" },
  deepScan: { scanned: 1, critical: 0, high: 0, blocking: false },
};

// Security gate allowed, but an engineering invariant (a new runtime dependency)
// withholds the handoff - the negative path.
const WITHHELD_RESPONSE = {
  ...PIPELINE_RESPONSE,
  approvalId: null,
  invariants: { ruleId: "R-DEPENDENCY-ADDED-ESCALATE", intendedOutcome: "escalate", wouldBlock: true, reason: "adds a runtime dependency" },
};

test.describe("Code factory reality check", () => {
  test("unauthenticated visit to /admin/ai-code redirects to /login (never blank)", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/ai-code`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 }).catch(() => null);
    expect(page.url().includes("/login"), "unauthenticated /admin/ai-code lands on /login, not a blank page").toBe(true);
  });

  test("a prompt runs the factory and renders the executor + gate verdict cleanly", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    // Stub the pipeline so no paid model runs; the contract is covered elsewhere.
    await page.route("**/api/admin/ai-code/pipeline", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PIPELINE_RESPONSE) });
    });

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-code`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    expect(nav?.status(), "/admin/ai-code loads (not 401/blank)").toBe(200);

    // The page mounts, not a blank surface.
    await expect(page.getByTestId("ai-code-page"), "the factory page container mounts").toBeVisible({ timeout: 8_000 });

    // Submit a prompt (the input-to-output entry point).
    await page.getByLabel("Prompt").fill("Add a pure isPalindrome(s) function in src/lib/strings.ts with tests.");
    await page.getByRole("button", { name: /generate & gate/i }).click();

    // The executor (which model authored) and the gate verdict render.
    await expect(page.getByText("gpt-4o-mini"), "the executor model is shown").toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Allowed/), "the gate verdict pill renders").toBeVisible();
    await expect(page.getByText(/Ready for PR/).first(), "the ready-for-PR status renders").toBeVisible();

    // The governance panel surfaces the invariants + deep scan + handoff state.
    await expect(page.getByTestId("governance-panel"), "the governance panel renders").toBeVisible();
    await expect(page.getByText(/Invariants: clear/)).toBeVisible();
    await expect(page.getByText(/Deep scan: clean/)).toBeVisible();
    await expect(page.getByTestId("handoff-status")).toContainText(/handoff captured/i);

    // No CSP or network failures during a short idle window.
    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `CSP/network failures on /admin/ai-code:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });

  test("the negative path: a change the security gate allows but an invariant blocks is WITHHELD from handoff", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await page.route("**/api/admin/ai-code/pipeline", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WITHHELD_RESPONSE) });
    });

    const snapshot = collectConsoleAndNetworkFailures(page);
    await page.goto(`${target.baseUrl}/admin/ai-code`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.getByTestId("ai-code-page")).toBeVisible({ timeout: 8_000 });
    await page.getByLabel("Prompt").fill("Add a feature that pulls in a new dependency.");
    await page.getByRole("button", { name: /generate & gate/i }).click();

    // The verdict allowed, but the governance panel shows the invariant block and
    // the handoff is explicitly withheld - the whole point of the layer.
    await expect(page.getByText(/Invariant: R-DEPENDENCY-ADDED-ESCALATE/), "the blocking invariant is shown").toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("handoff-status")).toContainText(/Withheld from PR handoff/i);

    await page.waitForTimeout(1_500);
    const failures = snapshot();
    expect(failures, `CSP/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
