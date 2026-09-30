/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockList = jest.fn();
const mockEnroll = jest.fn();
const mockSetEnabled = jest.fn();
const mockUnenroll = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/ai-code/watched-repos", () => ({
  ...jest.requireActual("@/lib/ai-code/watched-repos"),
  listWatchedRepos: (...a: unknown[]) => mockList(...a),
  enrollRepo: (...a: unknown[]) => mockEnroll(...a),
  setRepoEnabled: (...a: unknown[]) => mockSetEnabled(...a),
  unenrollRepo: (...a: unknown[]) => mockUnenroll(...a),
}));

import { GET, POST, DELETE } from "../route";
const post = (body: unknown) => new NextRequest("http://localhost/api/admin/ai-code/watched-repos", { method: "POST", body: JSON.stringify(body) });
const del = (qs: string) => new NextRequest(`http://localhost/api/admin/ai-code/watched-repos?${qs}`, { method: "DELETE" });
const get = () => new NextRequest("http://localhost/api/admin/ai-code/watched-repos");

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockList.mockResolvedValue([]);
});

it("401 unauth / 403 unentitled on every verb", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  expect((await POST(post({ repo: "o/r" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(post({ repo: "o/r" }))).status).toBe(403);
});

it("400 on a malformed repo", async () => {
  expect((await POST(post({ repo: "not a repo" }))).status).toBe(400);
  expect((await DELETE(del("repo=bad"))).status).toBe(400);
});

it("enrolls a repo, workspace-scoped, and audits", async () => {
  const res = await POST(post({ repo: "o/r" }));
  expect(res.status).toBe(200);
  expect(mockEnroll).toHaveBeenCalledWith("w1", "o/r");
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.watched_repo_set", resourceId: "w1:o/r" }));
});

it("enabled:false pauses instead of enrolling", async () => {
  await POST(post({ repo: "o/r", enabled: false }));
  expect(mockSetEnabled).toHaveBeenCalledWith("w1", "o/r", false);
  expect(mockEnroll).not.toHaveBeenCalled();
});

it("DELETE removes and audits", async () => {
  const res = await DELETE(del("repo=o/r"));
  expect(res.status).toBe(200);
  expect(mockUnenroll).toHaveBeenCalledWith("w1", "o/r");
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.watched_repo_removed" }));
});

it("GET lists the workspace's repos", async () => {
  mockList.mockResolvedValue([{ repo: "o/r", enabled: true, createdAt: "2026-09-30T00:00:00Z" }]);
  const res = await GET(get());
  const body = await res.json();
  expect(mockList).toHaveBeenCalledWith("w1");
  expect(body.repos[0].repo).toBe("o/r");
});
