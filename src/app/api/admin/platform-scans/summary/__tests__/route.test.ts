/**
 * Contract for GET /api/admin/platform-scans/summary.
 *   200 -> { summary, scans } from the store (severity + category rollup + history).
 *   ?platform -> passed through to summarizeFindings.
 *   gate failure -> 403, no store calls.
 * store + auth are mocked so the route's gate + delegation are asserted with no DB.
 */
const mockSummarize = jest.fn();
const mockListScans = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/store", () => ({
  summarizeFindings: (...a: unknown[]) => mockSummarize(...a),
  listScans: (...a: unknown[]) => mockListScans(...a),
}));

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

function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockSummarize.mockResolvedValue(SUMMARY);
  mockListScans.mockResolvedValue(SCANS);
});

it("returns the summary + scan history (200)", async () => {
  const res = await get("http://localhost/api/admin/platform-scans/summary");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ summary: SUMMARY, scans: SCANS });
  expect(mockSummarize).toHaveBeenCalledWith("ws-1", undefined);
  expect(mockListScans).toHaveBeenCalledWith("ws-1");
});

it("passes ?platform through to summarizeFindings", async () => {
  await get("http://localhost/api/admin/platform-scans/summary?platform=acme-crm");
  expect(mockSummarize).toHaveBeenCalledWith("ws-1", "acme-crm");
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
});
