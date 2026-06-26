/**
 * Platform-scan persistence + learning tie-in. The db, analytics, and Brain
 * boundaries are mocked, so the store's write fan-out (scan header + per-finding
 * rows), the analytics stream (finding_detected per finding + completed), the
 * Brain ingest per finding, and the triage workflow are all asserted without a
 * database.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockIngest = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/platform-scan/brain-ingest", () => ({ ingestPlatformScanFinding: (...a: unknown[]) => mockIngest(...a) }));

import { recordScan, listFindings, triageFinding } from "@/lib/platform-scan/store";
import type { PlatformScanResult } from "@/lib/platform-scan/types";

const RESULT: PlatformScanResult = {
  platform: "wolfpack-auto",
  baseUrl: "https://demo.example.com",
  routeCount: 3,
  okCount: 1,
  findings: [
    { route: "/admin/leads", severity: "critical", category: "bug", title: "Server error (500)", detail: "boom", evidence: { status: 500 } },
    { route: "/admin/x", severity: "high", category: "broken_journey", title: "Route 404s", detail: "gone", evidence: { status: 404 } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIngest.mockResolvedValue(undefined);
});

it("recordScan writes the header + one row per finding, emits analytics, and feeds the Brain", async () => {
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-1" }] }) // header insert
    .mockResolvedValue({ rows: [] }); // finding inserts

  const out = await recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT });

  expect(out).toEqual({ scanId: "scan-1", findingCount: 2, criticalCount: 1 });
  // 1 header insert + 2 finding inserts.
  expect(mockWriteQuery).toHaveBeenCalledTimes(3);
  expect(mockWriteQuery.mock.calls[0][0]).toMatch(/INSERT INTO instinct_platform_scans/);
  expect(mockWriteQuery.mock.calls[1][0]).toMatch(/INSERT INTO instinct_platform_scan_findings/);
  // Learning: a finding_detected per finding + a completed event + a Brain summary per finding.
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_finding_detected", "admin-1", "admin", expect.objectContaining({ route: "/admin/leads", severity: "critical" }));
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_completed", "admin-1", "admin", expect.objectContaining({ finding_count: 2, critical_count: 1 }));
  expect(mockIngest).toHaveBeenCalledTimes(2);
  expect(mockIngest).toHaveBeenCalledWith("wolfpack-auto", expect.objectContaining({ route: "/admin/leads" }));
});

it("recordScan with zero findings still records the run and emits completion", async () => {
  mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "scan-2" }] });
  const out = await recordScan({ workspaceId: "ws-1", actorId: "a", actorRole: "admin", result: { ...RESULT, findings: [] } });
  expect(out).toEqual({ scanId: "scan-2", findingCount: 0, criticalCount: 0 });
  expect(mockWriteQuery).toHaveBeenCalledTimes(1); // header only
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_completed", "a", "admin", expect.objectContaining({ finding_count: 0 }));
  expect(mockIngest).not.toHaveBeenCalled();
});

it("listFindings filters by workspace + status, worst severity first", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ id: "f1", scan_id: "s1", platform: "wolfpack-auto", route: "/x", severity: "critical", category: "bug", title: "t", detail: "d", evidence: { status: 500 }, status: "open", created_at: "t" }] });
  const out = await listFindings("ws-1", { status: "open" });
  expect(out[0]).toMatchObject({ id: "f1", severity: "critical", status: "open" });
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/ORDER BY CASE severity/);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "open", null, 200]);
});

it("triageFinding moves a finding and emits a triage event", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [{ id: "f1", scan_id: "s1", platform: "wolfpack-auto", route: "/x", severity: "high", category: "bug", title: "t", detail: "d", evidence: {}, status: "resolved", created_at: "t" }] });
  const out = await triageFinding("f1", "ws-1", "resolved", "admin-1", "admin");
  expect(out).toMatchObject({ id: "f1", status: "resolved" });
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_finding_triaged", "admin-1", "admin", expect.objectContaining({ status: "resolved" }));
});

it("triageFinding returns null when the finding is not found", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [] });
  expect(await triageFinding("nope", "ws-1", "acknowledged", "admin-1", "admin")).toBeNull();
  expect(mockTrackEvent).not.toHaveBeenCalled();
});
