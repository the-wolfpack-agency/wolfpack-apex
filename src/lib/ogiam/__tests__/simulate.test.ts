/**
 * Enforcement simulator (pure replay). Proves the blast-radius math: which
 * recorded decisions a candidate enforce-set would NEWLY block, what already
 * blocks, the per-capability/per-agent/per-outcome breakdown, sample capping,
 * and case-insensitive capability matching. No DB — pure over injected rows.
 */
import { simulate } from "../simulate";
import type { SimDecisionRow } from "../queries";

function row(p: Partial<SimDecisionRow>): SimDecisionRow {
  return {
    capability: "tasks.write",
    tool: "create_task",
    principal_agent: "agent-1",
    would_block: false,
    intended_outcome: "allow",
    enforced: false,
    risk_tier: "medium",
    ...p,
  };
}

test("counts newly-blocked: would_block, not enforced, capability in candidate", () => {
  const rows = [
    row({ capability: "finance.write", would_block: true, intended_outcome: "escalate", enforced: false }),
    row({ capability: "finance.write", would_block: true, intended_outcome: "escalate", enforced: false }),
    row({ capability: "tasks.write", would_block: false }), // not blocking
  ];
  const r = simulate(rows, { enforceCapabilities: ["finance.write"] }, 30);
  expect(r.decisions).toBe(3);
  expect(r.newlyBlocked).toBe(2);
  expect(r.unaffected).toBe(1);
  expect(r.byOutcome).toEqual({ escalate: 2 });
});

test("currentlyBlocked counts would_block AND already enforced (not newly blocked)", () => {
  const rows = [
    row({ capability: "finance.send", would_block: true, enforced: true, intended_outcome: "deny" }),
    row({ capability: "finance.send", would_block: true, enforced: false, intended_outcome: "deny" }),
  ];
  const r = simulate(rows, { enforceCapabilities: ["finance.send"] }, 7);
  expect(r.currentlyBlocked).toBe(1); // the already-enforced one
  expect(r.newlyBlocked).toBe(1); // the not-yet-enforced one
});

test("a capability NOT in the candidate set is never newly blocked", () => {
  const rows = [row({ capability: "mail.send", would_block: true, enforced: false })];
  const r = simulate(rows, { enforceCapabilities: ["finance.write"] }, 30);
  expect(r.newlyBlocked).toBe(0);
});

test("capability matching is case-insensitive", () => {
  const rows = [row({ capability: "Finance.Write", would_block: true, enforced: false, intended_outcome: "escalate" })];
  const r = simulate(rows, { enforceCapabilities: ["finance.write"] }, 30);
  expect(r.newlyBlocked).toBe(1);
});

test("breakdowns by capability + agent are sorted by newly-blocked desc", () => {
  const rows = [
    row({ capability: "a.write", principal_agent: "x", would_block: true, enforced: false }),
    row({ capability: "b.write", principal_agent: "y", would_block: true, enforced: false }),
    row({ capability: "b.write", principal_agent: "y", would_block: true, enforced: false }),
  ];
  const r = simulate(rows, { enforceCapabilities: ["a.write", "b.write"] }, 30);
  expect(r.byCapability[0]).toMatchObject({ capability: "b.write", newlyBlocked: 2, total: 2 });
  expect(r.byAgent[0]).toEqual({ agent: "y", newlyBlocked: 2 });
});

test("samples are capped at 10", () => {
  const rows = Array.from({ length: 25 }, () =>
    row({ capability: "x.write", would_block: true, enforced: false }),
  );
  const r = simulate(rows, { enforceCapabilities: ["x.write"] }, 30);
  expect(r.newlyBlocked).toBe(25);
  expect(r.samples).toHaveLength(10);
});

test("empty ledger -> zeroed report, never throws", () => {
  const r = simulate([], { enforceCapabilities: ["finance.write"] }, 30);
  expect(r).toMatchObject({ decisions: 0, newlyBlocked: 0, currentlyBlocked: 0, unaffected: 0 });
  expect(r.samples).toEqual([]);
});
