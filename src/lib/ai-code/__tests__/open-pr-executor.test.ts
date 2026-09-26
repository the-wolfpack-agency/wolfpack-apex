/** @jest-environment node
 *
 * The approved handoff that opens a REAL PR. It must: commit each NEW file to a
 * fresh branch and open a PR (returning the URL); refuse a diff with no new
 * files (Stage 1 scope) without touching GitHub; refuse when no token; and never
 * throw (a recorded ok:false is the audited outcome).
 */
const createBranch = jest.fn();
const putFile = jest.fn();
const openPullRequest = jest.fn();
const workspaceGithubClient = jest.fn();
const authorize = jest.fn();
const recordActionOutcome = jest.fn();

jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => workspaceGithubClient(...a),
  createBranch: (...a: unknown[]) => createBranch(...a),
  putFile: (...a: unknown[]) => putFile(...a),
  openPullRequest: (...a: unknown[]) => openPullRequest(...a),
}));
jest.mock("@/lib/ogiam/authorize", () => ({ authorize: (...a: unknown[]) => authorize(...a) }));
jest.mock("@/lib/ogiam/ledger", () => ({ recordActionOutcome: (...a: unknown[]) => recordActionOutcome(...a) }));

import { executeOpenPr } from "../open-pr-executor";

const NEW_FILE_DIFF = `diff --git a/src/lib/is-even.ts b/src/lib/is-even.ts
new file mode 100644
--- /dev/null
+++ b/src/lib/is-even.ts
@@ -0,0 +1,1 @@
+export const isEven = (n: number) => n % 2 === 0;`;

const EDIT_ONLY_DIFF = `diff --git a/src/lib/x.ts b/src/lib/x.ts
--- a/src/lib/x.ts
+++ b/src/lib/x.ts
@@ -1 +1 @@
-export const x = 1;
+export const x = 2;`;

const ctx = { userId: "u1", userRole: "admin", workspaceId: "w1", agentId: "ai-code-gate" };

beforeEach(() => {
  jest.clearAllMocks();
  workspaceGithubClient.mockResolvedValue({ token: "ghp_test", fetch: globalThis.fetch });
  createBranch.mockResolvedValue(undefined);
  putFile.mockResolvedValue(undefined);
  openPullRequest.mockResolvedValue({ html_url: "https://github.com/o/r/pull/7", number: 7 });
  // Monitor mode: records the decision (recordedSeq set), never blocks.
  authorize.mockResolvedValue({ enforced: false, effectiveOutcome: "monitor", ruleId: "R-MUTATION-ALLOW", reason: "ok", recordedSeq: 42 });
  recordActionOutcome.mockResolvedValue(undefined);
});

test("routes the PR-open through the OGIAM gate (governed like every agent write)", async () => {
  await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ tool: "ai_code.open_pr", capability: "code.write", isMutation: true, principal: expect.objectContaining({ kind: "ai_agent", agent: "instinct.ai_code" }) }),
  );
});

test("an enforce-mode gate block short-circuits before any GitHub write, and records the blocked outcome", async () => {
  authorize.mockResolvedValue({ enforced: true, effectiveOutcome: "deny", ruleId: "R-SECRET-DENY", reason: "secret in params", recordedSeq: 7 });
  const out = await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/gate_blocked: R-SECRET-DENY/);
  expect(createBranch).not.toHaveBeenCalled();
  expect(openPullRequest).not.toHaveBeenCalled();
  // the block is captured on the ledger as an outcome, not just a decision
  expect(recordActionOutcome).toHaveBeenCalledWith(expect.objectContaining({ decisionSeq: 7, ok: false, code: "gate_blocked" }));
});

test("records the OUTCOME on the ledger (decision + outcome), not just the decision", async () => {
  await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(recordActionOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ decisionSeq: 42, agentId: "instinct.ai_code", ok: true, code: "ok" }),
  );
});

test("does not record an outcome when the decision was not recorded (no seq)", async () => {
  authorize.mockResolvedValue({ enforced: false, effectiveOutcome: "monitor", ruleId: "R-MUTATION-ALLOW", reason: "ok" }); // no recordedSeq
  await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(recordActionOutcome).not.toHaveBeenCalled();
});

test("opens a real PR for a new-file change: branch + commit + PR", async () => {
  const out = await executeOpenPr({ ref: "add-is-even", prompt: "add isEven", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.url).toBe("https://github.com/o/r/pull/7");
    expect(out.files).toBe(1);
    expect(out.branch).toMatch(/^factory\/add-is-even-[0-9a-f]{8}$/); // deterministic, hashed
  }
  expect(createBranch).toHaveBeenCalledWith(expect.anything(), "o/r", expect.stringMatching(/^factory\//), "main");
  expect(putFile).toHaveBeenCalledWith(expect.anything(), "o/r", "src/lib/is-even.ts", expect.stringContaining("isEven"), expect.any(String), expect.stringMatching(/^factory\//));
  expect(openPullRequest).toHaveBeenCalledTimes(1);
});

test("the branch is deterministic for the same diff (a retried approval reuses it)", async () => {
  const a = await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  const b = await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(a.ok && b.ok && a.branch === b.branch).toBe(true);
});

test("refuses a modification-only diff without touching GitHub (Stage 1 = new files)", async () => {
  const out = await executeOpenPr({ ref: "edit", diff: EDIT_ONLY_DIFF, repo: "o/r" }, ctx);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/no file changes to commit/);
  expect(createBranch).not.toHaveBeenCalled();
  expect(openPullRequest).not.toHaveBeenCalled();
});

test("refuses when no GitHub token is configured", async () => {
  workspaceGithubClient.mockResolvedValue({ token: "", fetch: globalThis.fetch });
  const out = await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/no GitHub token/);
});

test("never throws: a GitHub error becomes a recorded ok:false", async () => {
  openPullRequest.mockRejectedValue(new Error("422 validation failed"));
  const out = await executeOpenPr({ ref: "x", diff: NEW_FILE_DIFF, repo: "o/r" }, ctx);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.reason).toMatch(/422/);
});

test("commits full-file CHANGES (edit-support), including a modified existing file", async () => {
  const out = await executeOpenPr(
    {
      ref: "edit-x",
      repo: "o/r",
      changes: [
        { path: "src/existing.ts", content: "export const x = 2; // modified" },
        { path: "src/new.ts", content: "export const y = 1;" },
      ],
    },
    ctx,
  );
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.files).toBe(2);
  // both files committed via putFile (create-or-update handles the modification)
  expect(putFile).toHaveBeenCalledTimes(2);
  expect(openPullRequest).toHaveBeenCalledTimes(1);
});
