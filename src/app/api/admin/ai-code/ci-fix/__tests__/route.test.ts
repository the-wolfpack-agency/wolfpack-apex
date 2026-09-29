/** @jest-environment node */
const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockFetchCiStatus = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
const mockFetchAttribution = jest.fn();
jest.mock("@/lib/ai-code/ci-status", () => ({
  fetchCiStatus: (...a: unknown[]) => mockFetchCiStatus(...a),
  fetchCiAttribution: (...a: unknown[]) => mockFetchAttribution(...a),
}));
const mockWorkspaceClient = jest.fn();
const mockCountFixCommits = jest.fn();
const mockListChangedFiles = jest.fn();
const mockListRuns = jest.fn();
const mockRerun = jest.fn();
const mockTriggerWorkflow = jest.fn();
const mockCommit = jest.fn();
const mockAuthorFiles = jest.fn();
const mockAssessChange = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockWorkspaceClient(...a),
  getBranchHead: async () => "headsha123",
  countBranchCommitsMatching: (...a: unknown[]) => mockCountFixCommits(...a),
  listChangedFiles: (...a: unknown[]) => mockListChangedFiles(...a),
  listWorkflowRunsRaw: (...a: unknown[]) => mockListRuns(...a),
  rerunFailedRun: (...a: unknown[]) => mockRerun(...a),
  triggerWorkflow: (...a: unknown[]) => mockTriggerWorkflow(...a),
}));
const mockGather = jest.fn();
const mockFetchFiles = jest.fn();
jest.mock("@/lib/ai-code/ci-failure-detail", () => {
  // The pure guards (hasFixAnchor / guardAuthoredFix) are exercised for REAL so
  // the anti-hallucination + fail-closed behavior is verified end-to-end; only
  // the IO functions are mocked.
  const actual = jest.requireActual("@/lib/ai-code/ci-failure-detail");
  return {
    gatherFailureContext: (...a: unknown[]) => mockGather(...a),
    buildEnrichedFixPrompt: (a: { brief: string }) => a.brief,
    extractFailingTestFiles: (text: string) =>
      Array.from(text.matchAll(/FAIL\s+(\S+)/g)).map((m) => m[1]),
    fetchFilesContent: (...a: unknown[]) => mockFetchFiles(...a),
    hasFixAnchor: actual.hasFixAnchor,
    guardAuthoredFix: actual.guardAuthoredFix,
  };
});
jest.mock("@/lib/ai-code/file-changes", () => ({
  commitFileChanges: (...a: unknown[]) => mockCommit(...a),
  filesToDiff: (changes: { path: string; content: string }[]) =>
    changes.map((c) => `+++ b/${c.path}\n${c.content}`).join("\n"),
}));
jest.mock("@/lib/ai-code/assess", () => ({ assessChange: (...a: unknown[]) => mockAssessChange(...a) }));
jest.mock("@/lib/ai-code/author", () => ({ authorFileChanges: (...a: unknown[]) => mockAuthorFiles(...a) }));
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: jest.fn() }) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ai-code/ci-fix", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const green = { total: 2, passed: 2, failed: 0, pending: 0, complete: true, ciComplete: true, failedChecks: [], failedDetails: [] };
const red = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, failedChecks: ["unit"], failedDetails: [{ name: "unit", summary: "a test failed" }] };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(null);
  mockWorkspaceClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockCountFixCommits.mockResolvedValue(0);
  // The change's files are the fixer's anchor. Default to the file the default
  // authored fix edits, so hasFixAnchor is satisfied and guardAuthoredFix passes
  // (the fix edits a real changed file) unless a test overrides both.
  mockListChangedFiles.mockResolvedValue(["src/x.ts"]);
  mockFetchFiles.mockResolvedValue([]);
  mockListRuns.mockResolvedValue([]);
  mockRerun.mockResolvedValue(true);
  mockTriggerWorkflow.mockResolvedValue({ run_id: null });
  mockGather.mockResolvedValue({ detail: "", files: [] });
  mockAuthorFiles.mockResolvedValue({ changes: [{ path: "src/x.ts", content: "export const x = 2;" }], author: "model-b", error: null });
  mockCommit.mockResolvedValue(["src/x.ts"]);
  // Default: the re-authored fix clears the combined gate.
  mockAssessChange.mockResolvedValue({ securityOutcome: "allow", invariantRuleId: "", invariantBlocked: false, deepScanCritical: 0, deepScanBlocking: false, handoffAllowed: true, blockedBy: null });
});

test("401 / 403 / 400 guards", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await POST(post({ repo: "o/r", ref: "b" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(post({ repo: "o/r", ref: "b" }))).status).toBe(403);
  mockGate.mockResolvedValue(null);
  expect((await POST(post({ repo: "o/r" }))).status).toBe(400);
});

test("green CI -> merge_ready, no brief", async () => {
  mockFetchCiStatus.mockResolvedValue(green);
  const body = await (await POST(post({ repo: "o/r", ref: "b" }))).json();
  expect(body.decision.action).toBe("merge_ready");
  expect(body.brief).toBeUndefined();
});

test("red CI with budget -> author_fix + a fix brief", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  const body = await (await POST(post({ repo: "o/r", ref: "b", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("author_fix");
  expect(body.brief).toMatch(/unit.*a test failed/);
});

test("red CI out of budget -> escalate_human", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  const body = await (await POST(post({ repo: "o/r", ref: "b", attempt: 3, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
});

test("400 on a malformed repo (owner/name)", async () => {
  expect((await POST(post({ repo: "not a repo", ref: "b" }))).status).toBe(400);
});

test("with a branch + red CI: authors and commits the fix to the PR branch", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockGather.mockResolvedValue({ detail: "FAIL src/x.test.ts\n  Expected 1 Received 2", files: [] }); // a real code error to act on
  const res = await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", attempt: 0, maxAttempts: 3 }));
  const body = await res.json();
  expect(body.decision.action).toBe("author_fix");
  expect(body.fix.files).toEqual(["src/x.ts"]);
  expect(body.terminal).toBe(false); // commit re-triggers CI; poll again
  expect(mockAuthorFiles).toHaveBeenCalled();
  expect(mockCommit).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "o/r", branch: "factory/b-abc" }));
});

test("with a branch + red CI + a fix that FAILS the gate: escalates, does NOT commit", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockGather.mockResolvedValue({ detail: "FAIL src/x.test.ts\n  Expected 1 Received 2", files: [] }); // a real code error to act on
  // The autonomously re-authored fix carries a critical finding; the gate refuses it.
  mockAssessChange.mockResolvedValue({ securityOutcome: "block", invariantRuleId: "", invariantBlocked: false, deepScanCritical: 1, deepScanBlocking: true, handoffAllowed: false, blockedBy: "security" });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/gate/i);
  expect(body.gate).toEqual({ cleared: false, blockedBy: "security" });
  expect(body.terminal).toBe(true);
  expect(mockCommit).not.toHaveBeenCalled(); // an ungated autonomous push is exactly what this prevents
});

test("with a branch + green CI: merge_ready, terminal, no commit", async () => {
  mockFetchCiStatus.mockResolvedValue(green);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc" }))).json();
  expect(body.decision.action).toBe("merge_ready");
  expect(body.terminal).toBe(true);
  expect(mockCommit).not.toHaveBeenCalled();
});

test("with base + all failures PRE-EXISTING (introduced 0): does NOT author, escalates to human", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: [], preexisting: ["unit"], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: true, reason: "pre-existing" });
  const body = await (await POST(post({ repo: "o/r", ref: "b", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(mockFetchAttribution).toHaveBeenCalledWith("o/r", "main", "b", "w1");
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/pre-existing|already failing on the base/i);
  expect(body.brief).toBeUndefined(); // nothing to author
});

test("with base + an INTRODUCED failure: authors a fix, brief targets only the introduced check", async () => {
  const red2 = { ...red, failed: 2, failedChecks: ["unit", "e2e"], failedDetails: [{ name: "unit", summary: "introduced break" }, { name: "e2e", summary: "pre-existing flake" }] };
  mockFetchCiStatus.mockResolvedValue(red2);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: ["e2e"], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  const body = await (await POST(post({ repo: "o/r", ref: "b", base: "main" }))).json();
  expect(body.decision.action).toBe("author_fix");
  expect(body.brief).toMatch(/unit/);
  expect(body.brief).not.toMatch(/e2e/); // pre-existing check is not briefed to the fixer
});

test("reads CI for the BRANCH (PR head), not the task-id ref (dogfooding find)", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  await POST(post({ repo: "o/r", ref: "pr-1", branch: "factory/pr-1-abc", attempt: 0, maxAttempts: 3 }));
  // The task-id "pr-1" is not a git ref; the CI read must use the branch.
  expect(mockFetchCiStatus).toHaveBeenCalledWith("o/r", "factory/pr-1-abc", "w1");
});

test("auto-fix budget is floored by the branch's OWN fix-commit history (attempt=0 cannot bypass it)", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  // The caller passes attempt:0, but the branch already carries maxAttempts
  // worth of "factory ci-fix:" commits. The real history wins: out of budget.
  mockCountFixCommits.mockResolvedValue(3);
  const res = await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }));
  const body = await res.json();
  expect(mockCountFixCommits).toHaveBeenCalledWith(expect.anything(), "o/r", "main", "factory/b-abc", "factory ci-fix:");
  expect(body.decision.action).toBe("escalate_human");
  expect(body.budget).toEqual({ attempt: 3, priorFixCommits: 3, maxAttempts: 3 });
  expect(mockCommit).not.toHaveBeenCalled(); // a runaway autonomous loop is exactly what this prevents
});

test("stalls on an authored test (budget left): authors a fix to CORRECT the wrong test, converging", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(1); // a fix was already committed, budget (max 3) remains
  mockGather.mockResolvedValue({ detail: "FAIL src/lib/__tests__/averageWordLength.test.ts\n  Expected 2.33 Received 2", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/averageWordLength.ts", "src/lib/__tests__/averageWordLength.test.ts"]);
  mockAuthorFiles.mockResolvedValue({ changes: [{ path: "src/lib/averageWordLength.ts", content: "export const x = 1;" }], author: "model-b", error: null });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  // No longer escalates: it authors a fix (which may correct the wrong test) so the loop converges.
  expect(body.decision.action).toBe("author_fix");
  expect(body.stalledOnAuthoredTest).toEqual({ testFiles: ["src/lib/__tests__/averageWordLength.test.ts"] });
  expect(mockAuthorFiles).toHaveBeenCalled();
  expect(mockCommit).toHaveBeenCalled();
  expect(body.terminal).toBe(false); // committed; poll again after CI re-runs
});

test("PERSISTENT stall (authored test still failing after reconciliation): escalates as an ambiguous-spec contradiction, does NOT author again", async () => {
  // The scored-matrix parseRange finding: the "fix the test" guidance already ran
  // (priorFixCommits >= 2) and the authored test is STILL failing -> source and
  // test disagree from an ambiguous spec; escalate instead of oscillating.
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(2); // >= 1 prior "fix the test" pass already made
  mockGather.mockResolvedValue({ detail: "FAIL src/lib/__tests__/parseRange.test.ts\n  Expected [1,2] Received [1,3]", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/parseRange.ts", "src/lib/__tests__/parseRange.test.ts"]);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/ambiguous spec/i);
  expect(body.unresolvedContradiction).toEqual({ testFiles: ["src/lib/__tests__/parseRange.test.ts"] });
  expect(body.stalledOnAuthoredTest).toBeUndefined();
  expect(mockAuthorFiles).not.toHaveBeenCalled(); // no more oscillating
  expect(mockCommit).not.toHaveBeenCalled();
});

test("does NOT stall when the failing test is NOT part of the change (pre-existing test file)", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(1);
  mockGather.mockResolvedValue({ detail: "FAIL src/lib/__tests__/somethingElse.test.ts", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/averageWordLength.ts"]); // failing test not authored here
  mockAuthorFiles.mockResolvedValue({ changes: [{ path: "src/lib/averageWordLength.ts", content: "export const x = 1;" }], author: "model-b", error: null });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("author_fix"); // proceeds to fix the source
  expect(body.stalledOnAuthoredTest).toBeUndefined();
});

test("budget spent: escalates to a human (bounded), no further commit", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(12); // budget (maxAttempts:3) long since spent
  // A plain source failure (not a stalled AUTHORED test), so it exercises the
  // budget-exhaustion path, not the ambiguous-spec contradiction path.
  mockGather.mockResolvedValue({ detail: "Expected 5 Received 4", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/averageWordLength.ts"]);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  // After the bounded attempts it hands to a human rather than looping forever.
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/after 3 fix attempt/i);
  expect(mockCommit).not.toHaveBeenCalled();
});

test("governance failure (guardrail/security check) escalates to a human, does NOT author or commit", async () => {
  const gov = { ...red, failedChecks: ["CodeQL"], failedDetails: [{ name: "CodeQL", summary: "alert" }] };
  mockFetchCiStatus.mockResolvedValue(gov);
  mockFetchAttribution.mockResolvedValue({ introduced: ["CodeQL"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced CodeQL" });
  mockCountFixCommits.mockResolvedValue(0);
  mockGather.mockResolvedValue({ detail: "CodeQL alert: injection", files: [] });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/governance\/policy gate/i);
  expect(body.governanceFailure).toEqual({ signal: "check:CodeQL" });
  expect(mockAuthorFiles).not.toHaveBeenCalled();
  expect(mockCommit).not.toHaveBeenCalled();
});

test("flake pre-filter: first attempt re-runs the failed job once and WAITS (does not author yet)", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(0);           // first attempt
  mockGather.mockResolvedValue({ detail: "Expected 5 Received 4", files: [] }); // mechanical
  mockListRuns.mockResolvedValue([{ id: 55, name: "unit", conclusion: "failure", runAttempt: 1 }]);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(mockRerun).toHaveBeenCalledWith(expect.anything(), "o/r", 55); // re-ran the failed job
  expect(body.decision.action).toBe("wait");
  expect(body.flakeRecheckTriggered).toBe(true);
  expect(mockAuthorFiles).not.toHaveBeenCalled(); // no fix authored until the re-run settles
});

test("no re-run once a fix has already been attempted (priorFixCommits > 0)", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(1);           // already fixing
  mockGather.mockResolvedValue({ detail: "Expected 5 Received 4", files: [] });
  mockListRuns.mockResolvedValue([{ id: 55, name: "unit", conclusion: "failure", runAttempt: 1 }]);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(mockRerun).not.toHaveBeenCalled();
  expect(body.decision.action).toBe("author_fix");
});

test("snapshot failure escalates (never auto-updates the snapshot), no author", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(0);
  mockGather.mockResolvedValue({ detail: "1 snapshot failed. press `u` to update them.", files: [] });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/SNAPSHOT/);
  expect(body.snapshotFailure).toBe(true);
  expect(mockAuthorFiles).not.toHaveBeenCalled();
});

test("lint failure with a deterministic-fix workflow configured: dispatches it + waits (NO model)", async () => {
  const orig = process.env.DETERMINISTIC_FIX_WORKFLOW;
  process.env.DETERMINISTIC_FIX_WORKFLOW = "factory-deterministic-fix.yml";
  try {
    mockFetchCiStatus.mockResolvedValue(red);
    mockFetchAttribution.mockResolvedValue({ introduced: ["lint"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced lint" });
    mockCountFixCommits.mockResolvedValue(0);
    mockGather.mockResolvedValue({ detail: "eslint: 'x' is assigned a value but never used  @typescript-eslint/no-unused-vars", files: [] });
    const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(expect.anything(), "o/r", "factory-deterministic-fix.yml", "factory/b-abc");
    expect(body.decision.action).toBe("wait");
    expect(body.deterministicFixDispatched).toBe(true);
    expect(mockAuthorFiles).not.toHaveBeenCalled();  // the model was NOT used for a lint fix
    expect(mockRerun).not.toHaveBeenCalled();          // and no flake re-run either
  } finally {
    if (orig === undefined) delete process.env.DETERMINISTIC_FIX_WORKFLOW; else process.env.DETERMINISTIC_FIX_WORKFLOW = orig;
  }
});

test("lint failure WITHOUT the workflow configured: falls through to the model path (unchanged)", async () => {
  delete process.env.DETERMINISTIC_FIX_WORKFLOW;
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["lint"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced lint" });
  mockCountFixCommits.mockResolvedValue(0);
  mockGather.mockResolvedValue({ detail: "eslint: no-unused-vars", files: [] });
  mockListRuns.mockResolvedValue([]); // no flake candidates -> author path
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  expect(body.decision.action).toBe("author_fix");
});

// --- Dogfooding regression: the deepMerge run ---------------------------------
// A live build of a deepMerge feature escalated after the fixer, given EMPTY
// failure context, hallucinated a wrong-path file (src/lib/utils/deepMerge.js)
// instead of editing the real changed file (src/lib/deepMerge.ts). These lock in
// both halves of the fix: fail-closed when there is no anchor, and reject a fix
// that edits none of the change's files.

test("no anchor at all (empty log, unknown changed files): refuses to author blind, escalates", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(1); // past the flake pre-filter, so it would author
  mockGather.mockResolvedValue({ detail: "", files: [] }); // blob expired -> empty context
  mockListChangedFiles.mockResolvedValue([]); // and no changed-file anchor available
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  // Empty detail with no code-level error escalates (deploy/setup/infra signature);
  // the reauthor-time fail-closed guard is the belt-and-suspenders behind it.
  expect(body.decision.reason).toMatch(/no readable code-level error|no fix|refusing to author blind|anchor/i);
  expect(mockCommit).not.toHaveBeenCalled(); // never commits a blind guess
});

test("fixer hallucinates a wrong-path file: rejected, escalates, does NOT commit a parallel file", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(1);
  mockGather.mockResolvedValue({ detail: "FAIL src/lib/__tests__/deepMerge.test.ts", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/deepMerge.ts", "src/lib/__tests__/deepMerge.test.ts"]);
  // The exact hallucination from the live run: a parallel .js at an invented path.
  mockAuthorFiles.mockResolvedValue({ changes: [{ path: "src/lib/utils/deepMerge.js", content: "export function deepMerge(){}" }], author: "model-b", error: null });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/parallel file|none of this change|no fix/i);
  expect(mockCommit).not.toHaveBeenCalled();
});

test("deploy/setup/infra failure (empty detail, INFRA-ONLY checks, past the flake re-run): escalates, does NOT author", async () => {
  // Infra checks (e2e, vercel-deploy, preflight) fail at setup so the log has no
  // code-level error (detailChars:0). The fixer must not burn attempts
  // re-authoring source for a deploy/infra failure it cannot repair.
  const infraRed = { total: 3, passed: 0, failed: 3, pending: 0, complete: true, ciComplete: false, failedChecks: ["e2e", "vercel-deploy", "preflight"], failedDetails: [{ name: "e2e", summary: "" }] };
  mockFetchCiStatus.mockResolvedValue(infraRed);
  mockFetchAttribution.mockResolvedValue({ introduced: ["e2e", "vercel-deploy", "preflight"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced" });
  mockCountFixCommits.mockResolvedValue(1); // past the flake pre-filter
  mockGather.mockResolvedValue({ detail: "", files: [] }); // no readable code error
  mockListChangedFiles.mockResolvedValue(["src/lib/deepMerge.ts"]);
  mockListRuns.mockResolvedValue([]); // no flake candidates
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
  expect(body.decision.reason).toMatch(/no readable code-level error/i);
  expect(body.unfixableNoDetail).toEqual({ checks: ["e2e", "vercel-deploy", "preflight"] });
  expect(mockAuthorFiles).not.toHaveBeenCalled();
  expect(mockCommit).not.toHaveBeenCalled();
});

test("empty detail on a CODE check (unit/lint) is NOT mis-escalated as infra: authors, anchored", async () => {
  // The apex #969 misfire: `unit (3/4)` + `lint-types` failed with empty detail
  // (our extractor missed jest's message). That is a real code failure, not infra
  // - the fixer must still try (anchored to the change), never escalate as infra.
  const codeRed = { total: 3, passed: 1, failed: 2, pending: 0, complete: true, ciComplete: false, failedChecks: ["unit (3/4)", "lint-types"], failedDetails: [{ name: "unit (3/4)", summary: "" }] };
  mockFetchCiStatus.mockResolvedValue(codeRed);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit (3/4)", "lint-types"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced" });
  mockCountFixCommits.mockResolvedValue(1); // past the flake pre-filter
  mockGather.mockResolvedValue({ detail: "", files: [] }); // extractor missed the code error
  mockListChangedFiles.mockResolvedValue(["src/__tests__/no-direct-auth-cookie.test.ts"]);
  mockListRuns.mockResolvedValue([]);
  mockAuthorFiles.mockResolvedValue({ changes: [{ path: "src/__tests__/no-direct-auth-cookie.test.ts", content: "// real test" }], author: "model-b", error: null });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("author_fix"); // NOT escalate_human
  expect(body.unfixableNoDetail).toBeUndefined();
  expect(mockAuthorFiles).toHaveBeenCalled();
});

test("empty detail on the FIRST attempt still re-runs once to rule out a flake before escalating", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(0); // first attempt
  mockGather.mockResolvedValue({ detail: "", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/deepMerge.ts"]);
  mockListRuns.mockResolvedValue([{ id: 77, name: "unit", conclusion: "failure", runAttempt: 1 }]);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(mockRerun).toHaveBeenCalledWith(expect.anything(), "o/r", 77); // flake re-run gets its chance first
  expect(body.decision.action).toBe("wait");
  expect(body.unfixableNoDetail).toBeUndefined(); // not escalated while the re-run is in flight
});

test("real code failure whose log names only the TEST file: authors, anchored to the changed source file", async () => {
  // A genuine jest failure (detail present) where the error names the test, not
  // the source. The fixer authors, and the changed-files anchor keeps it editing
  // the real source (src/lib/deepMerge.ts), never a hallucinated path.
  mockFetchCiStatus.mockResolvedValue(red);
  mockFetchAttribution.mockResolvedValue({ introduced: ["unit"], preexisting: [], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: false, reason: "introduced unit" });
  mockCountFixCommits.mockResolvedValue(1);
  mockGather.mockResolvedValue({ detail: "FAIL src/lib/__tests__/deepMerge.test.ts\n  Expected {a:1} Received {}", files: [] });
  mockListChangedFiles.mockResolvedValue(["src/lib/deepMerge.ts", "src/lib/__tests__/deepMerge.test.ts"]);
  mockAuthorFiles.mockResolvedValue({ changes: [{ path: "src/lib/deepMerge.ts", content: "export function deepMerge(){/*fixed*/}" }], author: "model-b", error: null });
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc", base: "main", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("author_fix");
  expect(body.unfixableNoDetail).toBeUndefined(); // there IS readable detail -> author
  expect(mockCommit).toHaveBeenCalled();
  expect(body.terminal).toBe(false);
});

