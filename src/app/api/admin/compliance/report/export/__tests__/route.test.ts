/**
 * Contract tests for /api/admin/compliance/report/export (GET signed evidence).
 *
 * Auth (401/403), missing id (400), unknown id for the workspace (404), the
 * happy path 200 returning the signed artifact, the format=html printable view,
 * workspace scoping (getReportById is called with the CALLER's workspace, so it
 * cannot export another workspace's report), and the compliance.evidence_exported
 * analytics. The store + export builder are mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockGetReportById = jest.fn();
const mockBuild = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/compliance/store", () => ({ getReportById: (...a: unknown[]) => mockGetReportById(...a) }));
jest.mock("@/lib/compliance/export", () => ({ buildEvidenceExport: (...a: unknown[]) => mockBuild(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
const req = (qs = "") =>
  new NextRequest(`https://x.test/api/admin/compliance/report/export${qs}`, {
    method: "GET",
    headers: { authorization: "Bearer t" },
  });

const storedReport = {
  id: "cmp_x",
  workspaceId: "w-1",
  framework: "SOC2",
  report: { framework: "SOC2", controls: [], covered: 0, partial: 0, gap: 0, coverage: 0, generatedNote: "n" },
  createdAt: "2026-06-30T00:00:00.000Z",
};

const artifact = {
  payload: { version: "1", kind: "compliance-evidence", reportId: "cmp_x", workspaceId: "w-1", framework: "SOC2", generatedAt: storedReport.createdAt, report: storedReport.report },
  canonicalPayload: '{"framework":"SOC2"}',
  signature: { algorithm: "ES256", keyId: "kv://k", signature: "sig", signed: true, payloadSha256: "a".repeat(64), canonicalization: "json-sorted-keys" },
  html: "<!doctype html><html><body>SOC2</body></html>",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockGetReportById.mockResolvedValue(storedReport);
  mockBuild.mockResolvedValue(artifact);
});

test("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req("?id=cmp_x"))).status).toBe(401);
});

test("403 when lacking capability", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await GET(req("?id=cmp_x"))).status).toBe(403);
});

test("400 when id is missing", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await GET(req())).status).toBe(400);
  expect(mockGetReportById).not.toHaveBeenCalled();
});

test("404 when the report id is unknown for this workspace", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockGetReportById.mockResolvedValue(null);
  const res = await GET(req("?id=does-not-exist"));
  expect(res.status).toBe(404);
  // Scoped to the caller's workspace - cannot probe another workspace's reports.
  expect(mockGetReportById).toHaveBeenCalledWith("w-1", "does-not-exist");
  expect(mockBuild).not.toHaveBeenCalled();
});

test("200 returns the signed artifact for an existing report + emits analytics", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await GET(req("?id=cmp_x"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.signature.signed).toBe(true);
  expect(body.payload.reportId).toBe("cmp_x");
  // Built from the STORED report scoped to the workspace, not client input.
  expect(mockGetReportById).toHaveBeenCalledWith("w-1", "cmp_x");
  expect(mockBuild).toHaveBeenCalledWith(
    expect.objectContaining({ reportId: "cmp_x", workspaceId: "w-1", report: storedReport.report }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "compliance.evidence_exported",
    "u-1",
    "cto",
    { framework: "SOC2", report_id: "cmp_x", signed: true },
  );
});

test("workspace scoping: a different workspace cannot export another's report (no IDOR)", async () => {
  // Caller is in workspace w-2; the report belongs to w-1, so getReportById(w-2, ...) returns null -> 404.
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u-9", role: "admin", workspaceId: "w-2" }, capabilities: new Set() });
  mockGetReportById.mockResolvedValue(null);
  const res = await GET(req("?id=cmp_x"));
  expect(res.status).toBe(404);
  expect(mockGetReportById).toHaveBeenCalledWith("w-2", "cmp_x");
});

test("format=html returns the printable HTML view as an attachment", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await GET(req("?id=cmp_x&format=html"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("content-disposition")).toContain(".html");
  expect(await res.text()).toContain("<!doctype html>");
});
