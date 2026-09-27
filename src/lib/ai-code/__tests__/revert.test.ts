/**
 * revertFactoryBranch: the guarded, governed revert. It ONLY resets factory
 * branches (never a human branch / release / main), refuses a bad sha, records
 * to the ledger, and is a no-op when the branch is already at the target.
 */
const mockGetHead = jest.fn();
const mockReset = jest.fn();
const mockAuthorize = jest.fn();
const mockRecordOutcome = jest.fn();

jest.mock("@/lib/github-client", () => ({
  getBranchHead: (...a: unknown[]) => mockGetHead(...a),
  resetBranchTo: (...a: unknown[]) => mockReset(...a),
}));
jest.mock("@/lib/ogiam/authorize", () => ({ authorize: (...a: unknown[]) => mockAuthorize(...a) }));
jest.mock("@/lib/ogiam/ledger", () => ({ recordActionOutcome: (...a: unknown[]) => mockRecordOutcome(...a) }));

import { revertFactoryBranch, isFactoryBranch } from "@/lib/ai-code/revert";

const client = { token: "t", fetch: jest.fn() } as never;
const base = {
  client,
  repoFullName: "acme/site",
  branch: "factory/pr-1-abc12345",
  toSha: "a".repeat(40),
  workspaceId: "w1",
  userId: "u1",
  userRole: "admin",
  trigger: "manual" as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ recordedSeq: 7, enforced: false, effectiveOutcome: "allow", ruleId: "R", reason: "" });
  mockRecordOutcome.mockResolvedValue(undefined);
  mockGetHead.mockResolvedValue("b".repeat(40)); // current head differs from target
  mockReset.mockResolvedValue(undefined);
});

test("isFactoryBranch: true only for a real factory/<name> branch", () => {
  expect(isFactoryBranch("factory/pr-1-abc")).toBe(true);
  expect(isFactoryBranch("factory/")).toBe(false); // prefix alone is not a branch
  expect(isFactoryBranch("main")).toBe(false);
  expect(isFactoryBranch("release/2.0")).toBe(false);
  expect(isFactoryBranch("feature/x")).toBe(false);
});

test("reverts a factory branch to the target and records the outcome", async () => {
  const out = await revertFactoryBranch(base);
  expect(out).toEqual({ ok: true, branch: base.branch, revertedTo: base.toSha, from: "b".repeat(40) });
  expect(mockReset).toHaveBeenCalledWith(client, "acme/site", base.branch, base.toSha);
  expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ ok: true, code: "ok", decisionSeq: 7 }));
});

test("REFUSES a non-factory branch: never rewrites a human branch, release, or main", async () => {
  for (const branch of ["main", "release/2.0", "feature/login", "develop"]) {
    const out = await revertFactoryBranch({ ...base, branch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/only reverts branches it created/i);
  }
  // The hard guarantee: no GitHub write ever happened for a non-factory branch.
  expect(mockReset).not.toHaveBeenCalled();
  expect(mockGetHead).not.toHaveBeenCalled();
});

test("refuses an invalid sha (not a branch name or ref)", async () => {
  const out = await revertFactoryBranch({ ...base, toSha: "main" });
  expect(out.ok).toBe(false);
  expect(mockReset).not.toHaveBeenCalled();
});

test("no-op when the branch is already at the target sha", async () => {
  mockGetHead.mockResolvedValue(base.toSha);
  const out = await revertFactoryBranch(base);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/already at the target/i);
  expect(mockReset).not.toHaveBeenCalled();
  expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "noop" }));
});

test("an enforce-mode gate block short-circuits before any GitHub write", async () => {
  mockAuthorize.mockResolvedValue({ recordedSeq: 7, enforced: true, effectiveOutcome: "block", ruleId: "R-BLOCK", reason: "denied" });
  const out = await revertFactoryBranch(base);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/gate_blocked/);
  expect(mockReset).not.toHaveBeenCalled();
});

test("a GitHub error is caught and recorded, never thrown", async () => {
  mockReset.mockRejectedValue(new Error("422 protected branch"));
  const out = await revertFactoryBranch(base);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/422/);
  expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "error" }));
});
