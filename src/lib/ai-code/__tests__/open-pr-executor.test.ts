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

jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => workspaceGithubClient(...a),
  createBranch: (...a: unknown[]) => createBranch(...a),
  putFile: (...a: unknown[]) => putFile(...a),
  openPullRequest: (...a: unknown[]) => openPullRequest(...a),
}));

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
  if (!out.ok) expect(out.reason).toMatch(/new-file changes only/);
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
