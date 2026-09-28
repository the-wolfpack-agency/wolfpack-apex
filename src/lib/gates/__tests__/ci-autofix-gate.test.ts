/**
 * The CI-autofix gate: the AUTO_FIX verdict + the safety rails. Covers the
 * verdict mapping (green->allow, governance->require_human, no-model-policy->
 * require_human, ungated-fix->require_human, mechanical+clean->auto_fix+commit)
 * with all IO mocked.
 */
const mockClient = jest.fn();
const mockGetBranchHead = jest.fn();
const mockCountFix = jest.fn();
const mockListChanged = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  getBranchHead: (...a: unknown[]) => mockGetBranchHead(...a),
  countBranchCommitsMatching: (...a: unknown[]) => mockCountFix(...a),
  listChangedFiles: (...a: unknown[]) => mockListChanged(...a),
}));
const mockCi = jest.fn();
const mockAttr = jest.fn();
jest.mock("@/lib/ai-code/ci-status", () => ({ fetchCiStatus: (...a: unknown[]) => mockCi(...a), fetchCiAttribution: (...a: unknown[]) => mockAttr(...a) }));
const mockGather = jest.fn();
jest.mock("@/lib/ai-code/ci-failure-detail", () => ({
  gatherFailureContext: (...a: unknown[]) => mockGather(...a),
  buildEnrichedFixPrompt: () => "PROMPT",
  extractFailingTestFiles: () => [],
}));
const mockAssess = jest.fn();
jest.mock("@/lib/ai-code/assess", () => ({ assessChange: (...a: unknown[]) => mockAssess(...a) }));
const mockCommit = jest.fn();
const mockRecordAudit = jest.fn();
jest.mock("@/lib/gates/audit", () => ({ recordGateDecision: (...a: unknown[]) => mockRecordAudit(...a) }));
const mockParse = jest.fn();
jest.mock("@/lib/ai-code/file-changes", () => ({
  commitFileChanges: (...a: unknown[]) => mockCommit(...a),
  filesToDiff: () => "diff",
  parseFileChanges: (...a: unknown[]) => mockParse(...a),
}));

import { ciAutofixGate } from "@/lib/gates/ci-autofix-gate";
import { runGate } from "@/lib/gates/run-gate";
import type { GateAgent } from "@/lib/gates/types";

const agent: GateAgent = { complete: jest.fn(async () => ({ content: "FIX", model_used: "client-model" })) };
const ctx = (allowModelData: "none" | "full" = "full") => ({ workspaceId: "w1", actorId: "u1", agent, policy: { frameworks: ["SOC2"], allowModelData } });
const input = { repo: "o/r", branch: "factory/x", base: "main" };
const red = (checks: string[]) => ({ total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, readable: true, failedChecks: checks, failedDetails: checks.map((n) => ({ name: n, summary: "x" })) });

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockGetBranchHead.mockResolvedValue("sha");
  mockCountFix.mockResolvedValue(0);
  mockListChanged.mockResolvedValue([]);
  mockAttr.mockResolvedValue({ introduced: ["agenticqa-full-pipeline"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false });
  mockGather.mockResolvedValue({ detail: "FAIL x\nExpected 5 Received NaN", files: [] });
  mockParse.mockReturnValue([{ path: "src/x.ts", content: "export const x = 1;" }]);
  mockAssess.mockResolvedValue({ handoffAllowed: true, blockedBy: null });
  mockCommit.mockResolvedValue(["src/x.ts"]);
  mockRecordAudit.mockResolvedValue({ recordedSeq: 99 });
});

it("allow: green CI", async () => {
  mockCi.mockResolvedValue({ complete: true, ciComplete: true, readable: true, failedChecks: [], failedDetails: [] });
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("allow");
});

it("require_human: CI unreadable", async () => {
  mockCi.mockResolvedValue({ complete: false, ciComplete: false, readable: false, unreadableReason: "token cannot read", failedChecks: [], failedDetails: [] });
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/could not be read/i);
});

it("require_human: governance failure is never auto-fixed", async () => {
  mockCi.mockResolvedValue(red(["CodeQL"]));
  mockAttr.mockResolvedValue({ introduced: ["CodeQL"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false });
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/governance\/policy gate/i);
  expect(mockCommit).not.toHaveBeenCalled();
});

it("require_human: policy forbids model data -> cannot auto-fix, code never sent to a model", async () => {
  mockCi.mockResolvedValue(red(["agenticqa-full-pipeline"]));
  const r = await runGate(ciAutofixGate, input, ctx("none"));
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/forbids sending code to a model/i);
  expect(agent.complete).not.toHaveBeenCalled();
  expect(mockCommit).not.toHaveBeenCalled();
});

it("require_human: a fix that fails the safety gate is NEVER committed", async () => {
  mockCi.mockResolvedValue(red(["agenticqa-full-pipeline"]));
  mockAssess.mockResolvedValue({ handoffAllowed: false, blockedBy: "security" });
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/did not clear the safety gate/i);
  expect(mockCommit).not.toHaveBeenCalled();
});

it("auto_fix: mechanical + clean fix -> authored with the client's model, gated, committed", async () => {
  mockCi.mockResolvedValue(red(["agenticqa-full-pipeline"]));
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("auto_fix");
  expect(agent.complete).toHaveBeenCalled();
  expect(mockCommit).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "o/r", branch: "factory/x" }));
  expect(r.output?.committedFiles).toEqual(["src/x.ts"]);
  expect(r.transparency.modelInvoked).toBe("client-model");
  expect(r.recordedSeq).toBe(99);           // self-audited before commit
  expect(mockRecordAudit).toHaveBeenCalled();
});

it("fail-closed: an UNAUDITABLE fix is NOT committed (no audit, no action)", async () => {
  mockCi.mockResolvedValue(red(["agenticqa-full-pipeline"]));
  mockRecordAudit.mockResolvedValue({ recordedSeq: null }); // ledger write failed
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/could not be written to the tamper-evident ledger/i);
  expect(mockCommit).not.toHaveBeenCalled(); // the irreversible commit never happened
});

it("require_human: model produced no usable changes", async () => {
  mockCi.mockResolvedValue(red(["agenticqa-full-pipeline"]));
  mockParse.mockReturnValue([]);
  const r = await runGate(ciAutofixGate, input, ctx());
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/no usable fix/i);
  expect(mockCommit).not.toHaveBeenCalled();
});
