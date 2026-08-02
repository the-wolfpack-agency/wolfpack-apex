/**
 * The budget actually stops a run.
 *
 * WHAT WAS WRONG
 *
 * The containment budget had four of its five moving parts: startRunSpend
 * opened the ledger, readRunSpend read it, decideStep decided against it, and
 * markBreached recorded the outcome. The fifth — addRunSpend — had no caller
 * anywhere in production, so recorded spend was permanently ZERO.
 *
 * decideStep therefore compared 0 against every ceiling, on every step, of
 * every run, and always proceeded. The control could not fail. Every agent run
 * had an unlimited allowance while the dashboard reported a healthy budget,
 * which is strictly worse than having no budget at all: an absent limit is a
 * known gap, and this was a gap everyone believed was closed.
 *
 * Found by the no-inert-controls sweep, not by anyone noticing.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM budget.test.ts
 *
 * That file tests decideStep as a pure function, and it passed throughout —
 * given a spend it decides correctly. It could not catch this, because the bug
 * was that no spend ever reached it. This one asserts the loop: run, spend,
 * read, refuse.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { decideStep, DEFAULT_BUDGET, type RunSpend } from "../budget";

const READABLE = { agentsEnabled: true, readable: true } as const;

const spend = (over: Partial<RunSpend> = {}): RunSpend => ({
  tokens: 0,
  durationMs: 0,
  egressCalls: 0,
  spendCents: 0,
  ...over,
});

describe("a ledger that never moves can never refuse", () => {
  it("proceeds forever at zero spend, which is what the bug looked like", () => {
    // Pinning the SHAPE of the bug: with spend stuck at zero, decideStep is
    // correct and useless. Nothing about this function was broken, which is
    // exactly why the failure survived — every unit test of it passed.
    for (let step = 0; step < 1000; step++) {
      expect(decideStep(DEFAULT_BUDGET, spend(), READABLE).proceed).toBe(true);
    }
  });

  it("refuses once recorded duration passes the ceiling", () => {
    const decision = decideStep(DEFAULT_BUDGET, spend({ durationMs: DEFAULT_BUDGET.maxDurationMs + 1 }), READABLE);
    expect(decision.proceed).toBe(false);
    if (!decision.proceed) expect(decision.breached).toBe("maxDurationMs");
  });

  it("refuses exactly at the ceiling, not one step later", () => {
    // Off-by-one here means one extra step at whatever the step costs, which
    // for an agent can be an outbound action.
    expect(decideStep(DEFAULT_BUDGET, spend({ durationMs: DEFAULT_BUDGET.maxDurationMs }), READABLE).proceed).toBe(
      false,
    );
  });
});

describe("the executor moves the ledger", () => {
  it("adds the duration of every step, so a long run converges on its ceiling", async () => {
    // The property the fix restores: spend accumulates. Asserted against the
    // real state module with the query layer mocked, so this is the SQL the
    // executor sends, not a stand-in for it.
    jest.resetModules();
    const calls: { sql: string; params: unknown[] }[] = [];
    jest.doMock("@/lib/db", () => ({
      safeQuery: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      },
    }));

    const { addRunSpend } = await import("../state");
    await addRunSpend("ws", "run-1", { durationMs: 1200 });
    await addRunSpend("ws", "run-1", { durationMs: 800 });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // Additive, not assignment: two concurrent steps must not lose each
      // other's usage the way a read-modify-write would.
      expect(call.sql).toMatch(/duration_ms\s*=\s*duration_ms\s*\+/);
      expect(call.params[0]).toBe("ws");
      expect(call.params[1]).toBe("run-1");
    }
    expect(calls[0].params[3]).toBe(1200);
    expect(calls[1].params[3]).toBe(800);

    jest.dontMock("@/lib/db");
    jest.resetModules();
  });
});

describe("an unmetered ceiling is not an enforced one", () => {
  it("tokens, egress and money still read as zero, because nothing meters them", () => {
    // Deliberate and stated rather than hidden. Inventing a number for these
    // would rebuild the same lie one layer up: a figure that looks like
    // enforcement and is not. The executor reports them as unmetered on
    // agent.task_completed so it is answerable from data.
    const decision = decideStep(DEFAULT_BUDGET, spend({ tokens: 0, egressCalls: 0, spendCents: 0 }), READABLE);
    expect(decision.proceed).toBe(true);
  });

  it("still refuses on those dimensions the moment a meter supplies a figure", () => {
    // The enforcement is real and waiting; only the measurement is missing. A
    // meter landing later needs no change to this path.
    expect(decideStep(DEFAULT_BUDGET, spend({ tokens: DEFAULT_BUDGET.maxTokens + 1 }), READABLE).proceed).toBe(false);
    expect(decideStep(DEFAULT_BUDGET, spend({ egressCalls: DEFAULT_BUDGET.maxEgressCalls + 1 }), READABLE).proceed).toBe(
      false,
    );
    expect(decideStep(DEFAULT_BUDGET, spend({ spendCents: DEFAULT_BUDGET.maxSpendCents + 1 }), READABLE).proceed).toBe(
      false,
    );
  });
});
