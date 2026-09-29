/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockClient = jest.fn();
const mockRepoInfo = jest.fn();
const mockListChecks = jest.fn();
const mockSave = jest.fn();
const mockGet = jest.fn();
const mockAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  fetchRepoInfo: (...a: unknown[]) => mockRepoInfo(...a),
  listCheckRuns: (...a: unknown[]) => mockListChecks(...a),
}));
jest.mock("@/lib/ai-code/baseline-store", () => ({
  saveRepoBaseline: (...a: unknown[]) => mockSave(...a),
  getRepoBaseline: (...a: unknown[]) => mockGet(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "127.0.0.1", userAgent: "t", requestId: "r" }),
}));

import { GET, POST } from "../route";
const url = (qs: string) => new NextRequest(`http://localhost/api/admin/ai-code/baseline?${qs}`);
const post = (body: unknown) => new NextRequest("http://localhost/api/admin/ai-code/baseline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockRepoInfo.mockResolvedValue({ defaultBranch: "main", private: true });
  mockListChecks.mockResolvedValue([{ name: "unit", status: "completed", conclusion: "success" }, { name: "e2e", status: "completed", conclusion: "failure" }]);
  mockSave.mockResolvedValue({ totalCount: 2, failingCount: 1, failingChecks: ["e2e"] });
  mockGet.mockResolvedValue(null);
  mockAudit.mockResolvedValue({ ok: true });
});

it("401 unauth / 403 unentitled on both verbs", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(url("repo=o/r"))).status).toBe(401);
  expect((await POST(post({ repo: "o/r" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(url("repo=o/r"))).status).toBe(403);
});

it("400 on a malformed repo", async () => {
  expect((await GET(url("repo=nope"))).status).toBe(400);
  expect((await POST(post({ repo: "nope" }))).status).toBe(400);
});

it("GET returns the stored baseline, workspace-scoped", async () => {
  mockGet.mockResolvedValue({ repo: "o/r", defaultBranch: "main", totalCount: 5, failingCount: 2, failingChecks: ["e2e", "lint"], checks: [], capturedAt: "2026-09-27T10:00:00Z" });
  const body = await (await GET(url("repo=o/r"))).json();
  expect(mockGet).toHaveBeenCalledWith("w1", "o/r");
  expect(body.baseline.failingCount).toBe(2);
});

it("POST captures the current default-branch checks as the baseline and audits it", async () => {
  const body = await (await POST(post({ repo: "o/r" }))).json();
  expect(mockRepoInfo).toHaveBeenCalledWith(expect.anything(), "o/r");
  expect(mockListChecks).toHaveBeenCalledWith(expect.anything(), "o/r", "main");
  expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", repo: "o/r", defaultBranch: "main", capturedBy: "u1" }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.baseline_captured", resourceType: "github_repo", resourceId: "o/r" }));
  expect(body).toMatchObject({ ok: true, repo: "o/r", defaultBranch: "main", failingCount: 1 });
});

it("POST with no GitHub token -> ok:false, no capture", async () => {
  mockClient.mockResolvedValue({ token: "", fetch: jest.fn() });
  const body = await (await POST(post({ repo: "o/r" }))).json();
  expect(body.ok).toBe(false);
  expect(body.reason).toMatch(/no GitHub credential/i);
  expect(mockSave).not.toHaveBeenCalled();
});

it("POST when the repo cannot be read -> ok:false, no capture", async () => {
  mockRepoInfo.mockRejectedValue(new Error("404"));
  const body = await (await POST(post({ repo: "o/r" }))).json();
  expect(body.ok).toBe(false);
  expect(body.reason).toMatch(/could not be read/i);
  expect(mockSave).not.toHaveBeenCalled();
});
