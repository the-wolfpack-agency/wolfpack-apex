/**
 * reinforceFromOutcome: joins an outcome to a handoff's memories (via provenance)
 * and reinforces (merge) / decays (reject) their confidence. Injected deps.
 */
import { reinforceFromOutcome, REINFORCE_FACTOR, DECAY_FACTOR, type ReinforceDeps } from "@/lib/ai-code/factory-reinforce";

function deps(over: Partial<ReinforceDeps> = {}): ReinforceDeps {
  return {
    loadProvenance: jest.fn(async () => [
      { kind: "reuse" as const, key: "src/a.ts" },
      { kind: "failure" as const, key: "sig1" },
    ]),
    adjustReuse: jest.fn(async () => ({ adjusted: 1 })),
    adjustFailure: jest.fn(async () => ({ adjusted: 1 })),
    ...over,
  };
}

it("merge REINFORCES both reuse + failure memories the run used", async () => {
  const d = deps();
  const r = await reinforceFromOutcome({ workspaceId: "w1", repo: "o/r", approvalId: "appr1", merged: true, deps: d });
  expect(r).toEqual({ reuse: 1, failure: 1 });
  expect(d.adjustReuse).toHaveBeenCalledWith("w1", "o/r", ["src/a.ts"], REINFORCE_FACTOR);
  expect(d.adjustFailure).toHaveBeenCalledWith("w1", "o/r", ["sig1"], REINFORCE_FACTOR);
});

it("closed-unmerged DECAYS them (factor < 1)", async () => {
  const d = deps();
  await reinforceFromOutcome({ workspaceId: "w1", repo: "o/r", approvalId: "appr1", merged: false, deps: d });
  expect(d.adjustReuse).toHaveBeenCalledWith("w1", "o/r", ["src/a.ts"], DECAY_FACTOR);
  expect(DECAY_FACTOR).toBeLessThan(1);
  expect(REINFORCE_FACTOR).toBeGreaterThan(1);
});

it("no-op without an approvalId (older PRs with no provenance link)", async () => {
  const d = deps();
  const r = await reinforceFromOutcome({ workspaceId: "w1", repo: "o/r", approvalId: undefined, merged: true, deps: d });
  expect(r).toEqual({ reuse: 0, failure: 0 });
  expect(d.loadProvenance).not.toHaveBeenCalled();
});

it("never throws if a dep throws", async () => {
  const d = deps({ loadProvenance: jest.fn(async () => { throw new Error("db"); }) });
  await expect(reinforceFromOutcome({ workspaceId: "w1", repo: "o/r", approvalId: "appr1", merged: true, deps: d })).resolves.toEqual({ reuse: 0, failure: 0 });
});
