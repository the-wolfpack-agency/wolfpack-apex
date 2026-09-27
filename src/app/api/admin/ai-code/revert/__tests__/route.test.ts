/** @jest-environment node */
const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockWorkspaceClient = jest.fn();
const mockRevert = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockWorkspaceClient(...a) }));
jest.mock("@/lib/ai-code/revert", () => ({ revertFactoryBranch: (...a: unknown[]) => mockRevert(...a) }));
const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "127.0.0.1", userAgent: "test", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ai-code/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VALID = { repo: "acme/site", branch: "factory/pr-1-abc12345", toSha: "a".repeat(40) };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(null);
  mockWorkspaceClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockRevert.mockResolvedValue({ ok: true, branch: VALID.branch, revertedTo: VALID.toSha, from: "b".repeat(40) });
  mockRecordAudit.mockResolvedValue({ ok: true });
});

test("401 without a session", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await POST(post(VALID))).status).toBe(401);
});

test("403 without the secure_agent entitlement", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(post(VALID))).status).toBe(403);
});

test("400 when repo, branch, or toSha is missing", async () => {
  expect((await POST(post({ repo: "acme/site", branch: "factory/x" }))).status).toBe(400);
  expect((await POST(post({ ...VALID, repo: "" }))).status).toBe(400);
});

test("400 on a malformed repo (owner/name)", async () => {
  expect((await POST(post({ ...VALID, repo: "not a repo" }))).status).toBe(400);
});

test("reverts and returns the outcome, passing the caller's workspace + role through", async () => {
  const body = await (await POST(post(VALID))).json();
  expect(body).toEqual({ ok: true, branch: VALID.branch, revertedTo: VALID.toSha, from: "b".repeat(40) });
  expect(mockRevert).toHaveBeenCalledWith(
    expect.objectContaining({ repoFullName: "acme/site", branch: VALID.branch, toSha: VALID.toSha, workspaceId: "w1", userId: "u1", userRole: "admin", trigger: "manual" }),
  );
});

test("passes trigger=canary_auto through for the auto-revert path", async () => {
  await POST(post({ ...VALID, trigger: "canary_auto" }));
  expect(mockRevert).toHaveBeenCalledWith(expect.objectContaining({ trigger: "canary_auto" }));
});

test("records a hash-chained audit entry for the branch rewrite", async () => {
  await POST(post(VALID));
  expect(mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "ai_code.branch_reverted", resourceType: "github_branch", resourceId: "acme/site#" + VALID.branch }),
  );
});

test("no GitHub token -> ok:false with a clear reason, no revert attempted", async () => {
  mockWorkspaceClient.mockResolvedValue({ token: "", fetch: jest.fn() });
  const body = await (await POST(post(VALID))).json();
  expect(body.ok).toBe(false);
  expect(body.reason).toMatch(/no GitHub token/i);
  expect(mockRevert).not.toHaveBeenCalled();
});
