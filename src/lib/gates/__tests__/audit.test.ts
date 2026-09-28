/**
 * The gate->ledger mapping: a gate verdict is an authorization decision, so it
 * must map onto the OGIAM ledger's outcomes correctly (auto_fix is a transform,
 * require_human is an escalate, deny is a deny) with the right risk tier and
 * would-block flag. Locks the semantics; recordDecision itself is mocked.
 */
const mockRecord = jest.fn();
jest.mock("@/lib/ogiam/ledger", () => ({ recordDecision: (...a: unknown[]) => mockRecord(...a) }));

import { recordGateDecision } from "@/lib/gates/audit";
import type { GateResult, GateVerdict } from "@/lib/gates/types";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: [], allowModelData: "none" as const } };
const resultFor = (verdict: GateVerdict): GateResult => ({
  verdict, findings: [], reason: "r",
  transparency: { checksRun: [], dataSeen: "", modelInvoked: null, frameworksApplied: [], explanation: "" },
  audit: { gate: "g", verdict, ruleId: "RULE-1", reason: "r", workspaceId: "w1", actorId: "u1" },
});

beforeEach(() => { jest.clearAllMocks(); mockRecord.mockResolvedValue({ id: "x", seq: 7, entryHash: "h" }); });

test.each([
  ["allow", "allow", "low", false],
  ["auto_fix", "transform", "medium", false],
  ["require_human", "escalate", "high", true],
  ["deny", "deny", "critical", true],
] as const)("verdict %s -> outcome %s, tier %s, wouldBlock %s", async (verdict, outcome, tier, wouldBlock) => {
  const r = await recordGateDecision("safe-review", resultFor(verdict), ctx, { diff: "d" });
  expect(r.recordedSeq).toBe(7);
  const arg = mockRecord.mock.calls[0][0];
  expect(arg.decision.intendedOutcome).toBe(outcome);
  expect(arg.decision.effectiveOutcome).toBe(outcome);
  expect(arg.decision.riskTier).toBe(tier);
  expect(arg.decision.wouldBlock).toBe(wouldBlock);
  expect(arg.decision.ruleId).toBe("RULE-1");
  expect(arg.principal).toMatchObject({ kind: "ai_agent", agent: "gate.safe-review", workspaceId: "w1" });
  expect(arg.redactedParams).not.toContain("diff"); // raw input never enters the ledger
});

test("a failed ledger write is non-fatal (recordedSeq null)", async () => {
  mockRecord.mockRejectedValue(new Error("db down"));
  expect(await recordGateDecision("safe-review", resultFor("allow"), ctx, {})).toEqual({ recordedSeq: null });
});

test("auto_fix is recorded as a state mutation (isMutation true)", async () => {
  await recordGateDecision("ci-autofix", resultFor("auto_fix"), ctx, {});
  expect(mockRecord.mock.calls[0][0].action.isMutation).toBe(true);
});
