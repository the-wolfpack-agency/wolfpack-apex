/** @jest-environment node */
/**
 * POST /api/admin/ai-code/pulls/merge contract: auth/entitlement, input validation,
 * the CI-green SAFETY FLOOR (never merge red/unverified), GitHub's refusal surfaced
 * (branch protection), and the happy path records ai_code.pr_merged.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockGate = jest.fn();
const mockClient = jest.fn();
const mockListOpen = jest.fn();
const mockMerge = jest.fn();
const mockStatus = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  listOpenPullRequests: (...a: unknown[]) => mockListOpen(...a),
  mergePullRequest: (...a: unknown[]) => mockMerge(...a),
}));
jest.mock("@/lib/ai-code/pull-approvals", () => ({ pullApprovalStatus: (...a: unknown[]) => mockStatus(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAuditNonFatal: (...a: unknown[]) => mockAudit(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";
const req = (body: unknown) => new NextRequest("http://localhost/api/admin/ai-code/pulls/merge", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockListOpen.mockResolvedValue([{ number: 5, headRef: "factory/x", baseRef: "main", title: "Add x", labels: [] }]);
  mockStatus.mockResolvedValue({ ciReadable: true, ciGreen: true });
  mockMerge.mockResolvedValue({ merged: true, mergedSha: "deadbeef", reason: "merged" });
  mockAudit.mockResolvedValue({ ok: true });
});

it("401 unauth / 403 unentitled", async () => {
  mockCap.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await POST(req({ repo: "o/r", prNumber: 5 }))).status).toBe(401);
  mockCap.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(req({ repo: "o/r", prNumber: 5 }))).status).toBe(403);
});

it("400 on bad input", async () => {
  expect((await POST(req({ repo: "", prNumber: 5 }))).status).toBe(400);
  expect((await POST(req({ repo: "o/r", prNumber: 0 }))).status).toBe(400);
  expect((await POST(req({ repo: "o/r", prNumber: "x" }))).status).toBe(400);
});

it("409 when the PR is not open in the repo", async () => {
  mockListOpen.mockResolvedValue([{ number: 9, headRef: "factory/y", baseRef: "main", title: "Other", labels: [] }]);
  expect((await POST(req({ repo: "o/r", prNumber: 5 }))).status).toBe(409);
});

it("SAFETY FLOOR: 409 + never merges when CI is not green", async () => {
  mockStatus.mockResolvedValue({ ciReadable: true, ciGreen: false });
  const res = await POST(req({ repo: "o/r", prNumber: 5 }));
  expect(res.status).toBe(409);
  expect(mockMerge).not.toHaveBeenCalled();
});

it("409 + never merges when CI is unreadable", async () => {
  mockStatus.mockResolvedValue({ ciReadable: false, ciGreen: false });
  const res = await POST(req({ repo: "o/r", prNumber: 5 }));
  expect(res.status).toBe(409);
  expect(mockMerge).not.toHaveBeenCalled();
});

it("GitHub refuses the merge (branch protection) -> 409 with the reason, no analytics", async () => {
  mockMerge.mockResolvedValue({ merged: false, reason: "GitHub refused the merge (HTTP 405): review required" });
  const res = await POST(req({ repo: "o/r", prNumber: 5 }));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toMatch(/review required/i);
  expect(mockTrack).not.toHaveBeenCalled();
});

it("happy path: merges and records ai_code.pr_merged (source: tool)", async () => {
  const res = await POST(req({ repo: "o/r", prNumber: 5 }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ merged: true, sha: "deadbeef" });
  expect(mockMerge).toHaveBeenCalledWith(expect.anything(), "o/r", 5, { method: "squash" });
  expect(mockTrack).toHaveBeenCalledWith("ai_code.pr_merged", "u1", "admin", expect.objectContaining({ repo: "o/r", pr_number: 5, source: "tool" }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.pr_merged", resourceType: "pull_request", resourceId: "o/r#5" }));
});
