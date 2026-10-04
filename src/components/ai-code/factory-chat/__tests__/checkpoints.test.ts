/**
 * The checkpoint mapper reflects REAL pipeline signals - a clean run clears every
 * gate, each failure mode blocks exactly its own checkpoint, a held run shows
 * "held" not "clear", and CI categories append as test checkpoints.
 */
import { deriveGateCheckpoints, deriveCheckpoints, deriveCiCheckpoints, trackSummary } from "@/components/ai-code/factory-chat/checkpoints";
import type { PipelineResult, CiDashboardLite } from "@/components/ai-code/factory-chat/types";

const clean: PipelineResult = {
  run: { status: "ready_for_pr", diff: "diff --git a/x b/x\n+ok" },
  executor: { author: "gpt-4o-mini", provider: "foundry" },
  executorAttempts: 1,
  invariants: { wouldBlock: false },
  deepScan: { blocking: false, critical: 0, high: 0 },
  duplication: { escalate: false },
  syntax: { ok: true },
  phantomImports: [], incompleteFiles: [], removedExports: [], anchorFailures: [], brokenLocalImports: [],
};
const byId = (cs: ReturnType<typeof deriveGateCheckpoints>) => Object.fromEntries(cs.map((c) => [c.id, c.status]));

describe("deriveGateCheckpoints", () => {
  it("a clean ready_for_pr run clears every gate checkpoint", () => {
    const s = byId(deriveGateCheckpoints(clean));
    expect(s).toEqual({ generated: "clear", security: "clear", duplication: "clear", compliance: "clear", integrity: "clear", verdict: "clear" });
  });

  it("a critical security finding blocks ONLY security + holds the verdict", () => {
    const s = byId(deriveGateCheckpoints({ ...clean, run: { status: "needs_human", diff: "x" }, deepScan: { blocking: true, critical: 1, high: 0 } }));
    expect(s.security).toBe("blocked");
    expect(s.verdict).toBe("held");
    expect(s.duplication).toBe("clear"); // other gates untouched
  });

  it("duplication / invariant / integrity each block their own checkpoint", () => {
    expect(byId(deriveGateCheckpoints({ ...clean, duplication: { escalate: true } })).duplication).toBe("blocked");
    expect(byId(deriveGateCheckpoints({ ...clean, invariants: { wouldBlock: true } })).compliance).toBe("blocked");
    expect(byId(deriveGateCheckpoints({ ...clean, phantomImports: [{}] })).integrity).toBe("blocked");
    expect(byId(deriveGateCheckpoints({ ...clean, syntax: { ok: false } })).integrity).toBe("blocked");
  });

  it("an executor that produced nothing blocks 'generated'", () => {
    const s = byId(deriveGateCheckpoints({ run: { status: "needs_human" }, executor: { error: "no change" } }));
    expect(s.generated).toBe("blocked");
  });

  it("a held (needs_human) run shows the verdict as held, not clear", () => {
    expect(byId(deriveGateCheckpoints({ ...clean, run: { status: "needs_human", diff: "x" } })).verdict).toBe("held");
  });
});

describe("deriveCiCheckpoints", () => {
  const ci: CiDashboardLite = {
    overall: "pending",
    categories: [
      { key: "security", label: "Security tests", status: "pass" },
      { key: "db", label: "Data tests", status: "pending" },
      { key: "e2e", label: "UI tests", status: "fail" },
    ],
  };
  it("maps CI statuses to checkpoint statuses", () => {
    const s = Object.fromEntries(deriveCiCheckpoints(ci).map((c) => [c.id, c.status]));
    expect(s).toEqual({ "ci:security": "clear", "ci:db": "pending", "ci:e2e": "blocked" });
  });
  it("is empty when there is no CI yet", () => {
    expect(deriveCiCheckpoints(null)).toEqual([]);
  });
});

describe("deriveCheckpoints + trackSummary", () => {
  it("appends CI after the gate and summarizes", () => {
    const ci: CiDashboardLite = { overall: "pass", categories: [{ key: "unit", label: "Unit", status: "pass" }] };
    const all = deriveCheckpoints(clean, ci);
    expect(all).toHaveLength(7); // 6 gate + 1 ci
    expect(trackSummary(all)).toEqual({ clear: 7, total: 7, blocked: 0, held: 0 });
  });
  it("counts blocked + held", () => {
    const sum = trackSummary(deriveGateCheckpoints({ ...clean, run: { status: "needs_human", diff: "x" }, deepScan: { blocking: true, critical: 1 } }));
    expect(sum.blocked).toBe(1);
    expect(sum.held).toBe(1);
  });
});
