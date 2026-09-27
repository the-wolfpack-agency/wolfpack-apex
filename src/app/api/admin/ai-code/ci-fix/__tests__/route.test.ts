/** @jest-environment node */
const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockFetchCiStatus = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/ci-status", () => ({ fetchCiStatus: (...a: unknown[]) => mockFetchCiStatus(...a) }));
const mockWorkspaceClient = jest.fn();
const mockCommit = jest.fn();
const mockAuthorFiles = jest.fn();
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockWorkspaceClient(...a) }));
jest.mock("@/lib/ai-code/file-changes", () => ({ commitFileChanges: (...a: unknown[]) => mockCommit(...a) }));
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

test("with a branch + green CI: merge_ready, terminal, no commit", async () => {
  mockFetchCiStatus.mockResolvedValue(green);
  const body = await (await POST(post({ repo: "o/r", ref: "b", branch: "factory/b-abc" }))).json();
  expect(body.decision.action).toBe("merge_ready");
  expect(body.terminal).toBe(true);
  expect(mockCommit).not.toHaveBeenCalled();
});
