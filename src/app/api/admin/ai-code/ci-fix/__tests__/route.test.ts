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
const mockCommit = jest.fn();
const mockAuthorFiles = jest.fn();
const mockAssessChange = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockWorkspaceClient(...a),
  getBranchHead: async () => "headsha123",
}));
jest.mock("@/lib/ai-code/ci-failure-detail", () => ({
  gatherFailureContext: async () => ({ detail: "", files: [] }),
  buildEnrichedFixPrompt: (a: { brief: string }) => a.brief,
}));
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
