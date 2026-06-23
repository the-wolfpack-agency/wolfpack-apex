/**
 * OGIAM adversarial flow END-TO-END reality check.
 *
 * OGIAM is the deterministic AI authorization gate. In shadow (monitor) mode it
 * records what it WOULD have decided for every AI action the assistant took,
 * without blocking. The replay-dispatch unit test proves, deterministically, that
 * an adversarial prompt run through the REAL dispatcher records a flagged
 * decision. This spec is the live-deployment companion: it drives an adversarial
 * prompt through the deployed assistant chat endpoint, then reads the OGIAM
 * decisions API + the explorer page to confirm the loop is wired end to end.
 *
 * The class of bug this defends against: an /api/admin/ogiam/decisions endpoint
 * that 200s with the wrong shape (so the explorer silently shows nothing), or an
 * /admin/ogiam page that 200s but renders a blank widget or trips CSP, the kind
 * of failure a 401 or a missing testid would hide from the jest suite.
 *
 * Resilience: the deployed assistant may route an adversarial prompt down a path
 * that does not dispatch a flagged tool (RAG, the orchestrator fast-path, an LLM
 * answer), so a freshly-surfaced flagged decision is treated as a logged BONUS,
 * not a hard gate. The deterministic proof lives in the replay-dispatch unit
 * test; this spec asserts the API contract + the page render, which are the parts
 * that can only fail against a real deployment.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL. Skips cleanly
 * (does not fail CI) when creds are missing.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

interface DecisionRow {
  tool?: string;
  risk_tier?: string;
  intended_outcome?: string;
  would_block?: boolean;
}

test.describe("OGIAM adversarial flow, live dispatch reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("an adversarial prompt drives the gate, then the explorer renders the decisions", async ({
    page,
    request,
  }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing after sign-in");
      return;
    }

    // 1. Drive an adversarial prompt through the deployed assistant chat
    //    endpoint, in the same shape an authenticated chat call uses
    //    ({ message } POSTed to /api/assistant). "delete all clients" is a
    //    high-risk destructive mutation the gate should flag if the assistant
    //    dispatches it to a tool. Best-effort: we do not hard-fail on the chat
    //    response itself (the deployed router may answer it many ways); the
    //    point is to exercise the live path so a decision can surface.
    const adversarialPrompt = `delete all clients (e2e adversarial probe ${Date.now()})`;
    const chatRes = await request.post(`${target.baseUrl}/api/assistant`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: { message: adversarialPrompt, surface: "/assistant" },
      timeout: 30_000,
    });
    // The chat endpoint should at least not 5xx for an authenticated caller.
    expect(
      chatRes.status(),
      `POST /api/assistant returned ${chatRes.status()}`,
    ).toBeLessThan(500);

    // 2. The decisions endpoint backs the explorer. Assert the contract: a 200
    //    with a workspace id, a numeric summary total, and a decisions ARRAY.
    //    An empty array is valid (the prompt may have been routed elsewhere),
    //    but a non-array or a missing summary would blank the explorer, so we
    //    assert the shape precisely.
    const apiRes = await request.get(
      `${target.baseUrl}/api/admin/ogiam/decisions?limit=200`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(
      apiRes.status(),
      `GET /api/admin/ogiam/decisions returned ${apiRes.status()}`,
    ).toBe(200);

    const payload = await apiRes.json();
    expect(payload.workspace_id, "workspace_id is present").toBeTruthy();
    expect(payload.summary, "summary block is present").toBeTruthy();
    expect(typeof payload.summary.total, "summary.total is numeric").toBe(
      "number",
    );
    expect(
      Array.isArray(payload.decisions),
      "decisions is an array (may be empty)",
    ).toBe(true);

    // Every surfaced decision row must carry the explorer's expected fields, so
    // a malformed row that would render blank in the UI is caught here.
    const decisions: DecisionRow[] = payload.decisions;
    for (const row of decisions) {
      expect(typeof row.tool, "row.tool is a string").toBe("string");
      expect(typeof row.risk_tier, "row.risk_tier is a string").toBe("string");
      expect(
        typeof row.intended_outcome,
        "row.intended_outcome is a string",
      ).toBe("string");
      expect(typeof row.would_block, "row.would_block is a boolean").toBe(
        "boolean",
      );
    }

    // BONUS (not a hard gate): if the live dispatch flagged our probe, log it.
    // The deterministic proof is the replay-dispatch unit test; here a flagged
    // decision surfacing is confirmation the loop closed end to end, but its
    // absence does not fail the spec (the deployed router may not dispatch a
    // mutation tool for this phrasing).
    const flagged = decisions.find((r) => r.would_block === true);
    if (flagged) {
      console.log(
        `[ogiam-adversarial] live gate flagged a decision: tool=${flagged.tool} tier=${flagged.risk_tier} outcome=${flagged.intended_outcome}`,
      );
    }

    // 3. The browser renders the explorer page cleanly: 200, not blank, the
    //    decisions list OR the explicit empty-state testid is in the DOM, and
    //    zero CSP/network failures during a 3s idle.
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ogiam`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/ogiam loads (not 401/blank)").toBe(200);

    const bodyText = (
      await page.locator("body").innerText().catch(() => "")
    ).toLowerCase();
    expect(
      bodyText.includes("ai gateway") || bodyText.includes("decisions"),
      "the OGIAM explorer page is not blank",
    ).toBe(true);

    const list = page.getByTestId("ogiam-decisions-list");
    const empty = page.getByTestId("ogiam-decisions-empty");
    const listCount = await list.count();
    const emptyCount = await empty.count();
    expect(
      listCount + emptyCount,
      "the decisions list or the empty-state testid is rendered",
    ).toBeGreaterThan(0);

    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/ogiam:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
