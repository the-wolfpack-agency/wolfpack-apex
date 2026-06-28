/**
 * Unit tests for the OGIAM gate self-test harness.
 *
 * These inject mocks for authorize / verifyChain / now / track so the harness is
 * deterministic and runs without a database. They prove the harness:
 *   - reports allPassed + correct + chainVerified + computed latency on a healthy gate,
 *   - CATCHES a broken gate (a case whose outcome != expect drops correct + allPassed),
 *   - surfaces a broken chain (chainVerified false when verifyChain reports a break),
 *   - computes latency percentiles correctly from injected durations,
 *   - fires platform.gate_selftest_run with the headline metrics,
 *   - never throws when the real gate throws (records the case as failed).
 */

import {
  runGateSelfTest,
  GATE_SELFTEST_CASES,
  type GateSelfTestDeps,
} from "../gate-selftest";
import type { OgiamDecision } from "../types";

/** A decision stub good enough for the harness (it reads effectiveOutcome + ruleId). */
function decision(
  effectiveOutcome: OgiamDecision["effectiveOutcome"],
  ruleId = "R-TEST",
): OgiamDecision {
  return {
    intendedOutcome: effectiveOutcome === "monitor" ? "allow" : effectiveOutcome,
    effectiveOutcome,
    enforced: true,
    mode: "enforce",
    riskTier: "low",
    policyVersion: "test",
    ruleId,
    reason: "test",
    wouldBlock: effectiveOutcome !== "allow",
  };
}

/** A `now` driven by an explicit queue of timestamps (two reads per case). */
function queuedNow(values: number[]): GateSelfTestDeps["now"] {
  let i = 0;
  return jest.fn(() => values[Math.min(i++, values.length - 1)]);
}

/** Healthy authorize: returns each case's EXPECTED outcome (allow -> "allow",
 *  deny -> "deny"), keyed by the case's tool so it tracks the real case set. */
function healthyAuthorize(): GateSelfTestDeps["authorize"] {
  return jest.fn(async (input) => {
    const c = GATE_SELFTEST_CASES.find((x) => x.input.tool === input.tool);
    return decision(c?.expect === "deny" ? "deny" : "allow", c?.name ?? "R-?");
  }) as GateSelfTestDeps["authorize"];
}

function healthyVerifyChain(): GateSelfTestDeps["verifyChain"] {
  return jest.fn(async () => ({
    ok: true,
    verifiedCount: GATE_SELFTEST_CASES.length,
    legacyCount: 0,
    brokenAtSeq: null,
    headSeq: GATE_SELFTEST_CASES.length,
    headHash: "head",
  })) as GateSelfTestDeps["verifyChain"];
}

function baseDeps(over: Partial<GateSelfTestDeps> = {}): Partial<GateSelfTestDeps> {
  return {
    // start/end pair per case so every case has a 5ms duration by default.
    now: queuedNow(GATE_SELFTEST_CASES.flatMap((_, i) => [i * 100, i * 100 + 5])),
    authorize: healthyAuthorize(),
    verifyChain: healthyVerifyChain(),
    track: jest.fn() as GateSelfTestDeps["track"],
    ...over,
  };
}

describe("runGateSelfTest", () => {
  test("healthy gate: allPassed true, correct == total, chainVerified, analytics fired", async () => {
    const deps = baseDeps();
    const report = await runGateSelfTest("ws-1", deps);

    expect(report.total).toBe(GATE_SELFTEST_CASES.length);
    expect(report.correct).toBe(report.total);
    expect(report.allPassed).toBe(true);
    expect(report.chainVerified).toBe(true);
    expect(report.cases.every((c) => c.ok)).toBe(true);

    for (const c of report.cases) {
      expect(typeof c.ms).toBe("number");
      expect(c.ms).toBeGreaterThanOrEqual(0);
      expect(c.outcome).toBeTruthy();
    }

    expect(deps.track).toHaveBeenCalledWith(
      "platform.gate_selftest_run",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        correct: report.correct,
        total: report.total,
        p50_ms: report.latency.p50,
        p95_ms: report.latency.p95,
        chain_verified: true,
      }),
    );
  });

  test("authorize runs in enforce mode for the target workspace principal", async () => {
    const authorize = healthyAuthorize();
    await runGateSelfTest("ws-42", baseDeps({ authorize }));

    expect(authorize).toHaveBeenCalledTimes(GATE_SELFTEST_CASES.length);
    const firstArg = (authorize as jest.Mock).mock.calls[0][0] as {
      mode: string;
      principal: { workspaceId: string };
    };
    expect(firstArg.mode).toBe("enforce");
    expect(firstArg.principal.workspaceId).toBe("ws-42");
  });

  test("CATCHES a broken gate: a case whose outcome != expect drops correct + allPassed", async () => {
    // Flip the secret-exfil case to "allow" (policy says DENY). The harness must
    // catch the regression: correct drops by one, allPassed is false.
    const authorize = jest.fn(async (input: { tool: string }) => {
      const c = GATE_SELFTEST_CASES.find((x) => x.input.tool === input.tool);
      if (c?.name === "secret-exfil") return decision("allow", "WRONG-ALLOW");
      return decision(c?.expect === "deny" ? "deny" : "allow");
    }) as unknown as GateSelfTestDeps["authorize"];

    const report = await runGateSelfTest("ws-1", baseDeps({ authorize }));

    expect(report.allPassed).toBe(false);
    expect(report.correct).toBe(report.total - 1);
    const broken = report.cases.find((c) => c.name === "secret-exfil");
    expect(broken?.ok).toBe(false);
    expect(broken?.outcome).toBe("allow");
  });

  test("surfaces a broken chain: chainVerified false when verifyChain reports a break", async () => {
    const verifyChain = jest.fn(async () => ({
      ok: false,
      verifiedCount: 2,
      legacyCount: 0,
      brokenAtSeq: 3,
      headSeq: 5,
      headHash: "head",
    })) as unknown as GateSelfTestDeps["verifyChain"];

    const report = await runGateSelfTest("ws-1", baseDeps({ verifyChain }));

    expect(report.chainVerified).toBe(false);
    // Case correctness is independent of chain integrity.
    expect(report.allPassed).toBe(true);
  });

  test("chainVerified false when verifyChain throws", async () => {
    const verifyChain = jest.fn(async () => {
      throw new Error("db down");
    }) as unknown as GateSelfTestDeps["verifyChain"];

    const report = await runGateSelfTest("ws-1", baseDeps({ verifyChain }));
    expect(report.chainVerified).toBe(false);
  });

  test("latency percentiles are computed from injected durations", async () => {
    // Feed start/end pairs so each case has a known duration:
    // durations = [1, 2, 3, 4, 5, 100] ms (6 cases).
    const wanted = [1, 2, 3, 4, 5, 100];
    expect(GATE_SELFTEST_CASES.length).toBe(wanted.length);

    const pairs: number[] = [];
    let clock = 0;
    for (const d of wanted) {
      pairs.push(clock); // start
      pairs.push(clock + d); // end
      clock += d + 1000; // gap so reads stay ordered
    }

    const report = await runGateSelfTest("ws-1", baseDeps({ now: queuedNow(pairs) }));

    // nearest-rank over sorted [1,2,3,4,5,100]:
    // p50 -> ceil(0.5*6)=3 -> idx 2 -> 3; p95 -> ceil(0.95*6)=6 -> idx 5 -> 100.
    expect(report.latency.p50).toBe(3);
    expect(report.latency.p95).toBe(100);
    expect(report.latency.max).toBe(100);
  });

  test("never throws when the real gate throws: the case is recorded as failed", async () => {
    const authorize = jest.fn(async () => {
      throw new Error("gate exploded");
    }) as unknown as GateSelfTestDeps["authorize"];

    const report = await runGateSelfTest("ws-1", baseDeps({ authorize }));

    expect(report.cases).toHaveLength(GATE_SELFTEST_CASES.length);
    expect(report.allPassed).toBe(false);
    expect(report.cases.every((c) => c.outcome === "error")).toBe(true);
  });

  // This test runs the cases through the REAL authorize() + decide() path (no
  // authorize mock), proving the representative cases actually exercise the live
  // policy rules and decide the way policy.ts intends. DATABASE_URL is unset, so
  // the ledger write is skipped cleanly and verifyChain degrades to an empty,
  // verifying chain - we still prove the decision outcomes are correct.
  test("REAL policy path: every representative case decides as policy intends", async () => {
    const prevDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // Only inject `now` and `track`; authorize + verifyChain are the real ones.
      const report = await runGateSelfTest("ws-real", {
        now: queuedNow(GATE_SELFTEST_CASES.flatMap((_, i) => [i * 100, i * 100 + 1])),
        track: jest.fn() as GateSelfTestDeps["track"],
      });

      expect(report.allPassed).toBe(true);
      expect(report.correct).toBe(report.total);

      // Spot-check that the expected RULE fired for the headline cases, proving
      // we hit the intended branches of decide(), not just any allow/deny.
      const byName = Object.fromEntries(report.cases.map((c) => [c.name, c]));
      expect(byName["benign-read"].outcome).toBe("allow");
      expect(byName["benign-read"].ruleId).toBe("R-DEFAULT-ALLOW");
      expect(byName["secret-exfil"].outcome).toBe("deny");
      expect(byName["secret-exfil"].ruleId).toBe("R-SECRET-DENY");
      expect(byName["high-risk-mutation"].outcome).toBe("escalate");
      expect(byName["high-risk-mutation"].ruleId).toBe("R-HIGHRISK-MUTATION-ESCALATE");
      expect(byName["pii-outbound"].outcome).toBe("transform");
      expect(byName["pii-outbound"].ruleId).toBe("R-PII-OUTBOUND-TRANSFORM");
      expect(byName["injection-on-mutation"].outcome).toBe("escalate");
      expect(byName["injection-on-mutation"].ruleId).toBe("R-INJECTION-ESCALATE");
      expect(byName["benign-mutation"].outcome).toBe("allow");
      expect(byName["benign-mutation"].ruleId).toBe("R-MUTATION-ALLOW");
    } finally {
      if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDbUrl;
    }
  });
});
