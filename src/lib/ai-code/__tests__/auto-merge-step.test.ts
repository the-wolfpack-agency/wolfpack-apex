/** @jest-environment node */
/**
 * maybeAutoMerge: the dark-by-default effect at merge_ready. Safety properties:
 * never attempts when the flag is off, and only enables for the low-risk tail
 * (small change, gate allow, no sensitive surface, tests present). Fail-open.
 */
const mockList = jest.fn();
const mockEnable = jest.fn();
const mockApprove = jest.fn();
const mockContents = jest.fn();
const mockMint = jest.fn();
jest.mock("@/lib/github-client", () => ({
  listChangedFiles: (...a: unknown[]) => mockList(...a),
  enableAutoMerge: (...a: unknown[]) => mockEnable(...a),
  approvePullRequest: (...a: unknown[]) => mockApprove(...a),
}));
jest.mock("@/lib/github-app", () => ({ mintInstallationToken: (...a: unknown[]) => mockMint(...a) }));
jest.mock("@/lib/ai-code/ci-failure-detail", () => ({ fetchFilesContent: (...a: unknown[]) => mockContents(...a) }));

import { maybeAutoMerge } from "@/lib/ai-code/auto-merge-step";

const client = { token: "pat", fetch: jest.fn() } as unknown as Parameters<typeof maybeAutoMerge>[0]["client"];
const BASE = { client, repo: "o/r", base: "main", branch: "factory/x", prNumber: 7 };
const ON = { AI_CODE_AUTO_MERGE: "on" };
const clean = (p: string) => ({ path: p, content: "export const x = 1;" });
const eligibleFiles = () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts", "src/lib/util/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
};

let savedPat: string | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockEnable.mockResolvedValue({ enabled: true, reason: "native auto-merge enabled" });
  // default: no app installation, self-approval blocked -> human approves
  mockMint.mockResolvedValue(null);
  mockApprove.mockResolvedValue({ approved: false, reason: "Can not approve your own pull request" });
  savedPat = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
  process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat";
});
afterEach(() => {
  if (savedPat === undefined) delete process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
  else process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = savedPat;
});

it("flag OFF -> never attempts, no IO at all", async () => {
  const r = await maybeAutoMerge({ ...BASE, env: {} });
  expect(r.attempted).toBe(false);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockEnable).not.toHaveBeenCalled();
});

it("no PR number -> never attempts", async () => {
  const r = await maybeAutoMerge({ ...BASE, prNumber: undefined, env: ON });
  expect(r.attempted).toBe(false);
  expect(mockEnable).not.toHaveBeenCalled();
});

it("eligible low-risk tail -> enables native auto-merge", async () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts", "src/lib/util/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r).toMatchObject({ attempted: true, enabled: true });
  expect(mockEnable).toHaveBeenCalledWith(client, "o/r", 7);
});

it("sensitive surface (auth) -> not attempted, keeps the human gate", async () => {
  mockList.mockResolvedValue(["src/lib/auth/require-capability.ts", "src/lib/auth/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/auth/require-capability.ts")]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/sensitive/);
  expect(mockEnable).not.toHaveBeenCalled();
});

it("no tests -> not attempted", async () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/test/);
});

it("gate block (introduced secret) -> not attempted", async () => {
  mockList.mockResolvedValue(["src/lib/util/x.ts", "src/lib/util/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([{ path: "src/lib/util/x.ts", content: 'const key = "sk-ant-abcdefghijklmnopqrstuvwx0123";' }]);
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/allow/);
});

it("too many files -> not attempted (big diff = human authorizes)", async () => {
  mockList.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`));
  const r = await maybeAutoMerge({ ...BASE, env: ON });
  expect(r.attempted).toBe(false);
  expect(r.reason).toMatch(/files/);
});

describe("policy approval (the required-review authorization half)", () => {
  it("eligible + bot identity available -> approves with the bot (non-author) token", async () => {
    eligibleFiles();
    mockMint.mockResolvedValue("ghs_bot_token");
    mockApprove.mockResolvedValue({ approved: true, reason: "approving review submitted" });
    const r = await maybeAutoMerge({ ...BASE, workspaceId: "ws1", env: ON });
    expect(r).toMatchObject({ attempted: true, enabled: true, approval: { approved: true } });
    // minted for the workspace, approved with the bot token (not the PAT author)
    expect(mockMint).toHaveBeenCalledWith("ws1");
    const approveClient = mockApprove.mock.calls[0][0] as { token: string };
    expect(approveClient.token).toBe("ghs_bot_token");
  });

  it("no distinct identity (bot=none, PAT is the author) -> auto-merge armed, approval skipped, human approves", async () => {
    eligibleFiles();
    mockMint.mockResolvedValue(null); // app not installed
    // PAT approve returns the self-approval 422 -> no distinct identity
    const r = await maybeAutoMerge({ ...BASE, workspaceId: "ws1", env: ON });
    expect(r.enabled).toBe(true); // still armed - merges once a human approves
    expect(r.approval?.approved).toBe(false);
  });

  it("ineligible change -> never approves", async () => {
    mockList.mockResolvedValue(["src/lib/auth/require-capability.ts"]);
    mockContents.mockResolvedValue([clean("src/lib/auth/require-capability.ts")]);
    const r = await maybeAutoMerge({ ...BASE, workspaceId: "ws1", env: ON });
    expect(r.attempted).toBe(false);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("flag OFF -> never approves (no IO)", async () => {
    const r = await maybeAutoMerge({ ...BASE, workspaceId: "ws1", env: {} });
    expect(r.attempted).toBe(false);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
  });
});
