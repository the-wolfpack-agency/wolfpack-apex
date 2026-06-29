/**
 * Contract tests for /api/admin/ai-code/review. Auth (401/403), POST validation
 * (400 on missing ref/diff), the happy-path verdict, the hash-chain audit, and
 * the ai_code.reviewed + per-finding analytics. The scan lib is mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockRun = jest.fn();
const mockList = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-code/scan", () => ({ runCodeReview: (...a: unknown[]) => mockRun(...a) }));
jest.mock("@/lib/ai-code/store", () => ({ listReviews: (...a: unknown[]) => mockList(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "../route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/admin/ai-code/review", {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockList.mockResolvedValue([]);
  mockRecordAudit.mockResolvedValue({ ok: true });
  mockRun.mockResolvedValue({
    ref: "PR-42",
    author: "cursor",
    findings: [{ file: "x", line: 1, klass: "secret", severity: "critical", cwe: "CWE-798", title: "t", detail: "d", evidence: {} }],
    verdict: { outcome: "block", highestSeverity: "critical", reason: "r", ruleId: "C-CRITICAL-BLOCK" },
    bySeverity: { critical: 1 },
    id: "acr_x",
  });
});

test("GET 401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req("GET"))).status).toBe(401);
});

test("POST 403 when lacking capability", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await POST(req("POST", { ref: "PR-1", diff: "x" }))).status).toBe(403);
});

test("POST 400 on missing ref or diff", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await POST(req("POST", { diff: "x" }))).status).toBe(400);
  expect((await POST(req("POST", { ref: "PR-1" }))).status).toBe(400);
  expect(mockRun).not.toHaveBeenCalled();
});

test("POST returns the verdict, audits it, and emits analytics", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await POST(req("POST", { ref: "PR-42", author: "cursor", diff: "diff --git ..." }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.verdict.outcome).toBe("block");

  expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w-1", ref: "PR-42", author: "cursor" }));
  expect(mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "ai_code.reviewed",
      resourceType: "ai_code_review",
      resourceId: "w-1:PR-42",
      afterState: expect.objectContaining({ outcome: "block", finding_count: 1 }),
    }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ai_code.reviewed",
    "u-1",
    "cto",
    expect.objectContaining({ ref: "PR-42", outcome: "block", findings: 1 }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ai_code.finding_detected",
    "u-1",
    "cto",
    expect.objectContaining({ class: "secret", severity: "critical", cwe: "CWE-798" }),
  );
});

test("POST defaults author to 'unknown' when omitted", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  await POST(req("POST", { ref: "PR-1", diff: "x" }));
  expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ author: "unknown" }));
});

test("GET returns the review history", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockList.mockResolvedValue([{ id: "acr_x", ref: "PR-1", author: "a", outcome: "allow", highestSeverity: "low", findingCount: 1, createdAt: "t" }]);
  const res = await GET(req("GET"));
  expect(res.status).toBe(200);
  expect((await res.json()).reviews).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith("w-1");
});
