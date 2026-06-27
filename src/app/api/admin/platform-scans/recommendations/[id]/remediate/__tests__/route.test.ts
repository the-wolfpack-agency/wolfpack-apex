/**
 * Contract for the remediate route. Auth (settings.manage_team), manifest repo
 * resolution, and the get -> openRemediationPR -> setRecommendationPr -> analytics
 * -> audit handoff, with every I/O boundary mocked. Covers happy path, already-open
 * short-circuit, 404 (no rec), 400 (no repo target), 403 (gate block), 502 (other
 * failure), and unauthorized.
 */
const mockGetRec = jest.fn();
const mockSetPr = jest.fn();
const mockResolve = jest.fn();
const mockOpenPr = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/manifests", () => ({ resolveScanTarget: (...a: unknown[]) => mockResolve(...a) }));
jest.mock("@/lib/platform-scan/recommend/store", () => ({
  getRecommendationById: (...a: unknown[]) => mockGetRec(...a),
  setRecommendationPr: (...a: unknown[]) => mockSetPr(...a),
}));
jest.mock("@/lib/platform-scan/recommend/remediation", () => ({ openRemediationPR: (...a: unknown[]) => mockOpenPr(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => { mockAudit(...a); return Promise.resolve(); },
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/recommendations/[id]/remediate/route";

const REC = {
  id: "rec-12345678",
  platform: "wolfpack-auto",
  key: "security_remediation:headers",
  category: "security_remediation",
  priority: "high",
  title: "Add a security-headers middleware",
  rationale: "3 responses missing headers.",
  suggestedAction: "Set the headers in middleware.",
  source: "finding:security",
  evidence: { count: 3 },
  status: "proposed",
  createdAt: "2026-06-27T00:00:00.000Z",
  prUrl: null,
};

function call(id = "rec-1") {
  const req = new NextRequest("http://localhost/api/admin/platform-scans/recommendations/rec-1/remediate", {
    method: "POST",
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockGetRec.mockResolvedValue({ ...REC });
  mockResolve.mockResolvedValue({ static: { owner: "o", repo: "r", ref: "main" } });
  mockOpenPr.mockResolvedValue({
    prUrl: "https://github.com/o/r/pull/7",
    prNumber: 7,
    branch: "b",
    decision: { effectiveOutcome: "monitor" },
  });
  mockSetPr.mockResolvedValue({ ...REC, status: "accepted", prUrl: "https://github.com/o/r/pull/7" });
});

it("happy path: opens the PR, persists it, tracks + audits, returns 200", async () => {
  const res = await call();
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toMatchObject({ ok: true, prUrl: "https://github.com/o/r/pull/7", prNumber: 7, branch: "b" });

  expect(mockOpenPr).toHaveBeenCalledWith(
    expect.objectContaining({ repoFullName: "o/r", baseBranch: "main", workspaceId: "ws-1" }),
  );
  expect(mockSetPr).toHaveBeenCalledWith("ws-1", "rec-1", "https://github.com/o/r/pull/7", "admin-1");
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.remediation_pr_opened",
    "admin-1",
    "admin",
    expect.objectContaining({ platform: "wolfpack-auto", pr_url: "https://github.com/o/r/pull/7" }),
  );
  expect(mockAudit).toHaveBeenCalled();
});

it("404 when the recommendation does not exist", async () => {
  mockGetRec.mockResolvedValue(null);
  const res = await call();
  expect(res.status).toBe(404);
  expect(mockOpenPr).not.toHaveBeenCalled();
});

it("alreadyOpen: a rec with a prUrl returns 200 and never re-opens", async () => {
  mockGetRec.mockResolvedValue({ ...REC, prUrl: "https://github.com/o/r/pull/3" });
  const res = await call();
  expect(res.status).toBe(200);
  expect((await res.json())).toMatchObject({ alreadyOpen: true });
  expect(mockOpenPr).not.toHaveBeenCalled();
});

it("400 when the manifest has no static repo target", async () => {
  mockResolve.mockResolvedValue({ routes: [], baseUrl: "https://x" });
  const res = await call();
  expect(res.status).toBe(400);
  expect(mockOpenPr).not.toHaveBeenCalled();
});

it("403 when the gate blocks (gate_blocked error)", async () => {
  mockOpenPr.mockRejectedValue(new Error("gate_blocked: r (x)"));
  const res = await call();
  expect(res.status).toBe(403);
  expect(mockSetPr).not.toHaveBeenCalled();
});

it("502 when openRemediationPR fails for any other reason", async () => {
  mockOpenPr.mockRejectedValue(new Error("github 500"));
  const res = await call();
  expect(res.status).toBe(502);
  expect(mockSetPr).not.toHaveBeenCalled();
});

it("403 unauthorized: never reads the recommendation", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await call();
  expect(res.status).toBe(403);
  expect(mockGetRec).not.toHaveBeenCalled();
});
