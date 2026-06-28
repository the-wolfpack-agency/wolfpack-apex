/**
 * Contract for GET /api/admin/platform-scans/summary.
 *   200 -> { summary, scans, uxPosture } from the store (severity + category
 *          rollup + history + the UX/accessibility posture grade).
 *   ?platform -> passed through to summarizeFindings + listFindings.
 *   uxPosture -> computed from the OPEN findings; fires platform.ux_posture_scored.
 *   gate failure -> 403, no store calls.
 * store + auth + analytics are mocked so the route's gate + delegation are
 * asserted with no DB.
 */
const mockSummarize = jest.fn();
const mockListScans = jest.fn();
const mockListFindings = jest.fn();
const mockTrackEvent = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/store", () => ({
  summarizeFindings: (...a: unknown[]) => mockSummarize(...a),
  listScans: (...a: unknown[]) => mockListScans(...a),
  listFindings: (...a: unknown[]) => mockListFindings(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/platform-scans/summary/route";

const SUMMARY = {
  total: 24,
  bySeverity: { critical: 3, high: 6, medium: 10, low: 5 },
  byCategory: { bug: 9, security: 13, ux_gap: 2 },
};
const SCANS = [
  { id: "scan-1", platform: "wolfpack-auto", baseUrl: "https://t.example", routeCount: 12, findingCount: 4, criticalCount: 1, createdAt: "2026-06-26T00:00:00.000Z" },
];

// Open findings the route scores. A high a11y gap + a low ux gap -> the high
// (weight 10) dominates -> grade D. Security/bug rows are present to prove the
// scorer ignores non-ux_gap categories.
const OPEN_FINDINGS = [
  { id: "u1", route: "/checkout", severity: "high", category: "ux_gap", title: "Accessibility: form inputs have no labels", detail: "", evidence: {}, status: "open" },
  { id: "u2", route: "/cart", severity: "low", category: "ux_gap", title: "Empty state missing on cart", detail: "", evidence: {}, status: "open" },
  { id: "s1", route: "/admin", severity: "critical", category: "security", title: "Admin served unauthenticated", detail: "", evidence: {}, status: "open" },
];

function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockSummarize.mockResolvedValue(SUMMARY);
  mockListScans.mockResolvedValue(SCANS);
  mockListFindings.mockResolvedValue(OPEN_FINDINGS);
});

it("returns the summary + scan history + uxPosture (200)", async () => {
  const res = await get("http://localhost/api/admin/platform-scans/summary");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { summary: unknown; scans: unknown; uxPosture: { grade: string; ux: number; a11y: number; total: number } };
  // Existing shape is preserved (additive).
  expect(body.summary).toEqual(SUMMARY);
  expect(body.scans).toEqual(SCANS);
  // UX posture computed over the open ux_gap findings: one high a11y + one low ux.
  expect(body.uxPosture).toMatchObject({ grade: "D", ux: 1, a11y: 1, total: 2 });
  expect(mockSummarize).toHaveBeenCalledWith("ws-1", undefined);
  expect(mockListScans).toHaveBeenCalledWith("ws-1");
  expect(mockListFindings).toHaveBeenCalledWith("ws-1", { status: "open", platform: undefined, limit: 500 });
});

it("fires platform.ux_posture_scored with the grade + counts", async () => {
  await get("http://localhost/api/admin/platform-scans/summary");
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.ux_posture_scored",
    "admin-1",
    "admin",
    { platform: "all", grade: "D", ux: 1, a11y: 1, total: 2 },
  );
});

it("grades A and fires the event when there are no open ux_gap findings", async () => {
  mockListFindings.mockResolvedValue([
    { id: "s1", route: "/admin", severity: "critical", category: "security", title: "x", detail: "", evidence: {}, status: "open" },
  ]);
  const res = await get("http://localhost/api/admin/platform-scans/summary");
  const body = (await res.json()) as { uxPosture: { grade: string; total: number } };
  expect(body.uxPosture).toMatchObject({ grade: "A", total: 0 });
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.ux_posture_scored",
    "admin-1",
    "admin",
    expect.objectContaining({ grade: "A", total: 0 }),
  );
});

it("passes ?platform through to summarizeFindings + listFindings + the event", async () => {
  await get("http://localhost/api/admin/platform-scans/summary?platform=acme-crm");
  expect(mockSummarize).toHaveBeenCalledWith("ws-1", "acme-crm");
  expect(mockListFindings).toHaveBeenCalledWith("ws-1", { status: "open", platform: "acme-crm", limit: 500 });
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.ux_posture_scored",
    "admin-1",
    "admin",
    expect.objectContaining({ platform: "acme-crm" }),
  );
});

it("includes per-scan coverage + degraded flag in the response so the report can render health", async () => {
  const SCANS_WITH_COVERAGE = [
    {
      id: "scan-deg", platform: "wolfpack-auto", baseUrl: "https://t.example",
      routeCount: 5, findingCount: 0, criticalCount: 0, createdAt: "2026-06-26T00:00:00.000Z",
      coverage: { attempted: 5, succeeded: 3, errored: 2, authRequired: true, authEstablished: false, coverageRatio: 0.6 },
      degraded: true,
    },
  ];
  mockListScans.mockResolvedValue(SCANS_WITH_COVERAGE);
  const res = await get("http://localhost/api/admin/platform-scans/summary");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { scans: typeof SCANS_WITH_COVERAGE };
  expect(body.scans[0].degraded).toBe(true);
  expect(body.scans[0].coverage).toMatchObject({ succeeded: 3, attempted: 5, errored: 2, authEstablished: false });
});

it("403s when the capability gate fails (no store calls)", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await get("http://localhost/api/admin/platform-scans/summary");
  expect(res.status).toBe(403);
  expect(mockSummarize).not.toHaveBeenCalled();
  expect(mockListScans).not.toHaveBeenCalled();
  expect(mockListFindings).not.toHaveBeenCalled();
  expect(mockTrackEvent).not.toHaveBeenCalled();
});
