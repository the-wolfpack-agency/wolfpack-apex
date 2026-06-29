/**
 * Platform-scan persistence + learning tie-in. The db, analytics, and Brain
 * boundaries are mocked, so the store's write fan-out (scan header + per-finding
 * rows), the analytics stream (finding_detected per finding + completed), the
 * Brain ingest per finding, and the triage workflow are all asserted without a
 * database.
 */
// mockWriteQuery now stands in for BOTH the top-level writeQuery (triage /
// bulkTriage) AND the in-transaction tx.write (recordScan header + findings +
// auto-resolve). recordScan was made ATOMIC: its writes run through
// withTransaction(fn) on ONE client. The mock withTransaction below invokes fn
// with a tx whose write() delegates to mockWriteQuery, so the existing
// call-ordering assertions (header, then findings, then auto-resolve) still hold,
// and a tx.write that throws (or returns 0 rows when expectRows is asserted)
// propagates out of withTransaction exactly as the real helper would.
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockIngest = jest.fn();
const mockNotify = jest.fn();

// Faithful stand-in for the real withTransaction: runs fn with a tx whose write()
// delegates to mockWriteQuery AND enforces the same expectRows row-count contract
// (throw on mismatch) so a 0-row write surfaces as an error in tests too. fn
// throwing propagates (the real helper rolls back + re-throws).
class FakeWriteError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
async function fakeWithTransaction(fn: (tx: unknown) => Promise<unknown>) {
  const tx = {
    async write(text: string, params?: unknown[], opts?: { expectRows?: number }) {
      const res = (await mockWriteQuery(text, params, opts)) as { rows: unknown[] };
      if (opts?.expectRows !== undefined && res.rows.length !== opts.expectRows) {
        throw new FakeWriteError(
          `row-count mismatch: expected ${opts.expectRows}, got ${res.rows.length}`,
          "unexpected_row_count",
        );
      }
      return res;
    },
  };
  return fn(tx);
}

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fakeWithTransaction(fn),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/platform-scan/brain-ingest", () => ({ ingestPlatformScanFinding: (...a: unknown[]) => mockIngest(...a) }));
jest.mock("@/lib/notifications/in-app", () => ({ notify: (...a: unknown[]) => mockNotify(...a) }));

import { recordScan, listFindings, triageFinding, bulkTriageFindings, summarizeFindings, listScans, isCoverageDegraded } from "@/lib/platform-scan/store";
import type { PlatformScanResult, ScanCoverage } from "@/lib/platform-scan/types";

const cleanCoverage: ScanCoverage = { attempted: 5, succeeded: 5, errored: 0, authRequired: true, authEstablished: true, coverageRatio: 1 };
const degradedCoverage: ScanCoverage = { attempted: 5, succeeded: 3, errored: 2, authRequired: true, authEstablished: false, coverageRatio: 0.6 };

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
  mockNotify.mockResolvedValue({ id: "n-1" });
});

it("recordScan writes the header + one row per finding, emits analytics, and feeds the Brain", async () => {
  // Each finding upsert now uses RETURNING id + expectRows:1, so it must return
  // exactly one row (a 0-row write would surface as an error - see the dedicated
  // 0-row test below).
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-1" }] }) // header insert
    .mockResolvedValue({ rows: [{ id: "f" }] }); // finding upserts return their id

  const out = await recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT });

  expect(out).toEqual({ scanId: "scan-1", findingCount: 2, criticalCount: 1, autoResolvedCount: 0 });
  // No scannedRoutes on this RESULT -> auto-resolve is skipped: header + 2 findings only, no UPDATE.
  // 1 header insert + 2 finding inserts.
  expect(mockWriteQuery).toHaveBeenCalledTimes(3);
  expect(mockWriteQuery.mock.calls[0][0]).toMatch(/INSERT INTO instinct_platform_scans/);
  expect(mockWriteQuery.mock.calls[1][0]).toMatch(/INSERT INTO instinct_platform_scan_findings/);
  // De-dup: a re-scan upserts on the finding identity instead of duplicating.
  expect(mockWriteQuery.mock.calls[1][0]).toMatch(/ON CONFLICT \(workspace_id, platform, route, title\) DO UPDATE/);
  // Learning: a finding_detected per finding + a completed event + a Brain summary per finding.
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_finding_detected", "admin-1", "admin", expect.objectContaining({ route: "/admin/leads", severity: "critical" }));
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_completed", "admin-1", "admin", expect.objectContaining({ finding_count: 2, critical_count: 1 }));
  expect(mockIngest).toHaveBeenCalledTimes(2);
  expect(mockIngest).toHaveBeenCalledWith("wolfpack-auto", expect.objectContaining({ route: "/admin/leads" }));
});

it("DATA-LOSS: a 0-row header write (RLS/view-discarded) surfaces as an ERROR, never a false scanId", async () => {
  // The header insert carries expectRows:1. A write the DB silently discarded
  // returns rows:[] - which the strict helper turns into a throw. recordScan must
  // propagate it (the transaction rolls back) instead of returning a scanId that
  // was never persisted.
  mockWriteQuery.mockResolvedValueOnce({ rows: [] }); // header discarded -> 0 rows
  await expect(
    recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT }),
  ).rejects.toThrow(/row-count mismatch/);
  // No finding upsert attempted (we never got a scan id) and no false success.
  expect(mockWriteQuery).toHaveBeenCalledTimes(1);
  expect(mockTrackEvent).not.toHaveBeenCalledWith("platform.scan_completed", expect.anything(), expect.anything(), expect.anything());
});

it("DATA-LOSS: a 0-row finding upsert surfaces as an ERROR (no partial false success)", async () => {
  // Header ok, but the SECOND finding upsert is silently discarded (0 rows). With
  // expectRows:1 that throws -> the whole transaction rolls back and recordScan
  // re-throws, so the caller never hears findingCount:0 / success for a partial write.
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-x" }] }) // header
    .mockResolvedValueOnce({ rows: [{ id: "f1" }] })     // first finding ok
    .mockResolvedValueOnce({ rows: [] });                // second finding discarded
  await expect(
    recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT }),
  ).rejects.toThrow(/row-count mismatch/);
});

it("ATOMICITY: a mid-loop finding write failure rolls back and re-throws (no orphaned partial, no findingCount:0)", async () => {
  // The real failure shape: header committed-in-tx, first finding ok, second
  // finding THROWS. The transaction must roll the whole unit back and recordScan
  // must re-throw so the caller sees an error - NOT a swallowed { findingCount: 0 }
  // that drops the data while reporting success.
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-y" }] }) // header
    .mockResolvedValueOnce({ rows: [{ id: "f1" }] })     // first finding ok
    .mockRejectedValueOnce(new Error("connection reset")); // second finding throws
  await expect(
    recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT }),
  ).rejects.toThrow(/connection reset/);
  // Completion analytics + Brain ingest are POST-COMMIT, so a rolled-back scan
  // emits no completion event and ingests nothing - nothing is reported as done.
  expect(mockTrackEvent).not.toHaveBeenCalledWith("platform.scan_completed", expect.anything(), expect.anything(), expect.anything());
  expect(mockIngest).not.toHaveBeenCalled();
});

it("HUMAN ALERTING: a critical finding notifies the admin who ran the scan, high priority, naming the platform + count", async () => {
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-c" }] })
    .mockResolvedValue({ rows: [{ id: "f" }] }); // finding upserts return a row (expectRows:1)

  await recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT });

  expect(mockNotify).toHaveBeenCalledTimes(1);
  expect(mockNotify).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "admin-1",
      priority: "high",
      category: "security",
      source: "platform_scan",
      sourceId: "scan-c",
      actionUrl: "/admin/platform-scans",
      title: expect.stringContaining("wolfpack-auto"),
      metadata: expect.objectContaining({ platform: "wolfpack-auto", critical_count: 1, scan_id: "scan-c" }),
    }),
  );
});

it("HUMAN ALERTING: zero critical findings does NOT notify (no alert spam)", async () => {
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-h" }] })
    .mockResolvedValue({ rows: [{ id: "f" }] });
  // A high finding but no critical → no alert.
  await recordScan({
    workspaceId: "ws-1",
    actorId: "admin-1",
    actorRole: "admin",
    result: { ...RESULT, findings: [RESULT.findings[1]] },
  });
  expect(mockNotify).not.toHaveBeenCalled();
});

it("HUMAN ALERTING: a notify throw does not break recordScan (best effort)", async () => {
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-e" }] })
    .mockResolvedValue({ rows: [{ id: "f" }] });
  mockNotify.mockRejectedValue(new Error("notifications down"));

  const out = await recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT });
  // The scan + findings still persisted and the call returned normally.
  expect(out).toEqual({ scanId: "scan-e", findingCount: 2, criticalCount: 1, autoResolvedCount: 0 });
  expect(mockNotify).toHaveBeenCalledTimes(1);
});

it("AUTO-RESOLVE: a covered route with no current finding resolves its stale open findings", async () => {
  // The scan covered two routes; only one still has a finding. The other route's
  // previously-open finding (the bug was fixed) must be auto-resolved.
  const resultWithCoverage: PlatformScanResult = {
    ...RESULT,
    findings: [
      { route: "/admin/leads", severity: "critical", category: "bug", title: "Server error (500)", detail: "boom", evidence: { status: 500 } },
    ],
    scannedRoutes: ["/admin/leads", "/admin/fixed"],
  };
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-AR" }] }) // header
    .mockResolvedValueOnce({ rows: [{ id: "f" }] })        // finding upsert (expectRows:1)
    .mockResolvedValueOnce({ rows: [{ id: "stale-1" }, { id: "stale-2" }] }); // auto-resolve UPDATE

  const out = await recordScan({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: resultWithCoverage });

  expect(out.autoResolvedCount).toBe(2);
  // header + 1 finding upsert + 1 auto-resolve UPDATE
  expect(mockWriteQuery).toHaveBeenCalledTimes(3);
  const updateCall = mockWriteQuery.mock.calls[2];
  expect(updateCall[0]).toMatch(/UPDATE instinct_platform_scan_findings/);
  expect(updateCall[0]).toMatch(/status = 'resolved'/);
  expect(updateCall[0]).toMatch(/route = ANY\(\$3::text\[\]\)/);
  // Scoped to covered routes; decided_by marks it as automatic.
  expect(updateCall[1]).toEqual(["ws-1", "wolfpack-auto", ["/admin/leads", "/admin/fixed"], "auto:rescan", "\x1f", ["/admin/leads\x1fServer error (500)"]]);
  // Aggregate learning signal.
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_findings_auto_resolved", "admin-1", "admin", expect.objectContaining({ platform: "wolfpack-auto", count: 2 }));
});

it("AUTO-RESOLVE: no event/UPDATE when nothing was stale (UPDATE returns 0 rows)", async () => {
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-AR2" }] })
    .mockResolvedValueOnce({ rows: [{ id: "f" }] }) // finding upsert (expectRows:1)
    .mockResolvedValueOnce({ rows: [] }); // UPDATE resolves nothing
  const out = await recordScan({
    workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin",
    result: { ...RESULT, findings: [RESULT.findings[0]], scannedRoutes: ["/admin/leads"] },
  });
  expect(out.autoResolvedCount).toBe(0);
  expect(mockTrackEvent).not.toHaveBeenCalledWith("platform.scan_findings_auto_resolved", expect.anything(), expect.anything(), expect.anything());
});

it("recordScan with zero findings still records the run and emits completion", async () => {
  mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "scan-2" }] });
  const out = await recordScan({ workspaceId: "ws-1", actorId: "a", actorRole: "admin", result: { ...RESULT, findings: [] } });
  expect(out).toEqual({ scanId: "scan-2", findingCount: 0, criticalCount: 0, autoResolvedCount: 0 });
  expect(mockWriteQuery).toHaveBeenCalledTimes(1); // header only
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_completed", "a", "admin", expect.objectContaining({ finding_count: 0 }));
  expect(mockIngest).not.toHaveBeenCalled();
});

describe("isCoverageDegraded rule", () => {
  it("clean, fully-covered, auth-established coverage is NOT degraded", () => {
    expect(isCoverageDegraded(cleanCoverage)).toBe(false);
  });
  it("any errored route makes it degraded", () => {
    expect(isCoverageDegraded({ ...cleanCoverage, errored: 1 })).toBe(true);
  });
  it("auth required but not established makes it degraded", () => {
    expect(isCoverageDegraded({ ...cleanCoverage, authEstablished: false })).toBe(true);
  });
  it("coverage ratio below the trust threshold makes it degraded", () => {
    expect(isCoverageDegraded({ ...cleanCoverage, coverageRatio: 0.79 })).toBe(true);
    expect(isCoverageDegraded({ ...cleanCoverage, coverageRatio: 0.8 })).toBe(false);
  });
  it("auth NOT required + no auth established flag is irrelevant (not degraded on auth axis)", () => {
    expect(isCoverageDegraded({ attempted: 3, succeeded: 3, errored: 0, authRequired: false, authEstablished: true, coverageRatio: 1 })).toBe(false);
  });
});

it("recordScan persists coverage on the header row", async () => {
  mockWriteQuery
    .mockResolvedValueOnce({ rows: [{ id: "scan-cov" }] })
    .mockResolvedValue({ rows: [] });
  await recordScan({
    workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin",
    result: { ...RESULT, findings: [], coverage: cleanCoverage },
  });
  const headerCall = mockWriteQuery.mock.calls[0];
  expect(headerCall[0]).toMatch(/attempted_routes, succeeded_routes, errored_routes, auth_established, coverage_ratio/);
  // params tail: attempted, succeeded, errored, auth_established, coverage_ratio
  const params = headerCall[1] as unknown[];
  expect(params.slice(-5)).toEqual([5, 5, 0, true, 1]);
});

it("recordScan with NO coverage persists zeros + nulls (never implies full coverage)", async () => {
  mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "scan-noc" }] }).mockResolvedValue({ rows: [{ id: "f" }] });
  await recordScan({ workspaceId: "ws-1", actorId: "a", actorRole: "admin", result: { ...RESULT, findings: [] } });
  const params = mockWriteQuery.mock.calls[0][1] as unknown[];
  expect(params.slice(-5)).toEqual([0, 0, 0, null, null]);
  expect(mockTrackEvent).not.toHaveBeenCalledWith("platform.scan_coverage_degraded", expect.anything(), expect.anything(), expect.anything());
});

it("recordScan fires platform.scan_coverage_degraded ONLY when coverage is degraded", async () => {
  mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "scan-deg" }] }).mockResolvedValue({ rows: [{ id: "f" }] });
  await recordScan({
    workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin",
    result: { ...RESULT, findings: [], coverage: degradedCoverage },
  });
  expect(mockTrackEvent).toHaveBeenCalledWith("platform.scan_coverage_degraded", "admin-1", "admin", {
    platform: "wolfpack-auto", attempted: 5, succeeded: 3, errored: 2, auth_ok: false,
  });
});

it("recordScan does NOT fire the degraded event for a clean, fully-covered scan", async () => {
  mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "scan-clean" }] }).mockResolvedValue({ rows: [{ id: "f" }] });
  await recordScan({
    workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin",
    result: { ...RESULT, findings: [], coverage: cleanCoverage },
  });
  expect(mockTrackEvent).not.toHaveBeenCalledWith("platform.scan_coverage_degraded", expect.anything(), expect.anything(), expect.anything());
});

it("listScans reconstructs coverage + degraded flag from the persisted columns", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { id: "s-deg", platform: "p", base_url: "b", route_count: 5, finding_count: 0, critical_count: 0, created_at: "t",
        attempted_routes: 5, succeeded_routes: 3, errored_routes: 2, auth_established: false, coverage_ratio: 0.6 },
      { id: "s-clean", platform: "p", base_url: "b", route_count: 4, finding_count: 0, critical_count: 0, created_at: "t",
        attempted_routes: 4, succeeded_routes: 4, errored_routes: 0, auth_established: true, coverage_ratio: 1 },
      { id: "s-old", platform: "p", base_url: "b", route_count: 0, finding_count: 0, critical_count: 0, created_at: "t",
        attempted_routes: 0, succeeded_routes: 0, errored_routes: 0, auth_established: null, coverage_ratio: null },
    ],
  });
  const out = await listScans("ws-1");
  expect(out[0]).toMatchObject({ id: "s-deg", degraded: true });
  expect(out[0].coverage).toMatchObject({ attempted: 5, succeeded: 3, errored: 2, coverageRatio: 0.6, authEstablished: false });
  expect(out[1]).toMatchObject({ id: "s-clean", degraded: false });
  expect(out[2]).toMatchObject({ id: "s-old", coverage: null, degraded: null });
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/attempted_routes, succeeded_routes, errored_routes, auth_established, coverage_ratio/);
});

it("listFindings filters by workspace + status, worst severity first", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ id: "f1", scan_id: "s1", platform: "wolfpack-auto", route: "/x", severity: "critical", category: "bug", title: "t", detail: "d", evidence: { status: 500 }, status: "open", created_at: "t" }] });
  const out = await listFindings("ws-1", { status: "open" });
  expect(out[0]).toMatchObject({ id: "f1", severity: "critical", status: "open" });
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/ORDER BY CASE severity/);
  // severity param is null when no band is requested -> spans all severities.
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "open", null, null, 200]);
});

it("listFindings narrows to a severity band via severity = ANY($N::text[])", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  await listFindings("ws-1", { status: "open", severities: ["critical", "high"] });
  // The SQL uses a nullable array predicate so absent = all, present = subset.
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/\$4::text\[\] IS NULL OR severity = ANY\(\$4\)/);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "open", null, ["critical", "high"], 200]);
});

it("listFindings treats an EMPTY severities array as no filter (all severities)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  await listFindings("ws-1", { severities: [] });
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", null, null, null, 200]);
});

it("bulkTriageFindings UPDATEs every matching OPEN finding, returns the count, emits ONE bulk event", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  const count = await bulkTriageFindings(
    "ws-1",
    { status: "acknowledged", severities: ["critical", "high"], platform: "acme-crm" },
    "admin-1",
    "admin",
  );
  expect(count).toBe(3);
  const [sql, params] = mockWriteQuery.mock.calls[0];
  // One UPDATE scoped to OPEN rows matching the active filter.
  expect(sql).toMatch(/UPDATE instinct_platform_scan_findings/);
  expect(sql).toMatch(/status = 'open'/);
  expect(sql).toMatch(/\$5::text\[\] IS NULL OR severity = ANY\(\$5\)/);
  expect(params).toEqual(["ws-1", "acme-crm", "acknowledged", "admin-1", ["critical", "high"]]);
  // Exactly one aggregate learning signal (not one per row).
  expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.scan_findings_bulk_triaged",
    "admin-1",
    "admin",
    expect.objectContaining({ status: "acknowledged", count: 3, severities: "critical,high", platform: "acme-crm" }),
  );
});

it("bulkTriageFindings with no filter passes null severities + null platform (all open)", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [] });
  const count = await bulkTriageFindings("ws-1", { status: "resolved" }, "admin-1", "admin");
  expect(count).toBe(0);
  expect(mockWriteQuery.mock.calls[0][1]).toEqual(["ws-1", null, "resolved", "admin-1", null]);
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.scan_findings_bulk_triaged",
    "admin-1",
    "admin",
    expect.objectContaining({ count: 0, severities: "all", platform: "all" }),
  );
});

it("summarizeFindings reduces GROUP BY rows into severity + category counts", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { severity: "critical", category: "bug", n: 2 },
      { severity: "high", category: "security", n: 3 },
      { severity: "high", category: "bug", n: 1 },
    ],
  });
  const out = await summarizeFindings("ws-1");
  expect(out.total).toBe(6);
  expect(out.bySeverity).toEqual({ critical: 2, high: 4, medium: 0, low: 0 });
  expect(out.byCategory).toEqual({ bug: 3, security: 3 });
  // OPEN-only, all-severity defaults present, platform filter null when absent.
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/status = 'open'/);
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/GROUP BY severity, category/);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", null]);
});

it("summarizeFindings passes the platform filter and defaults to all-zero with no rows", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  const out = await summarizeFindings("ws-1", "acme-crm");
  expect(out).toEqual({ total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {} });
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "acme-crm"]);
});

it("listScans returns recent runs newest-first, default limit 10, cap 50", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [{ id: "scan-1", platform: "wolfpack-auto", base_url: "https://t.example", route_count: 12, finding_count: 4, critical_count: 1, created_at: "2026-06-26T00:00:00.000Z" }],
  });
  const out = await listScans("ws-1");
  expect(out[0]).toMatchObject({ id: "scan-1", platform: "wolfpack-auto", baseUrl: "https://t.example", routeCount: 12, findingCount: 4, criticalCount: 1, createdAt: "2026-06-26T00:00:00.000Z" });
  // No coverage columns in this fixture row -> coverage unknown, degraded null.
  expect(out[0]).toMatchObject({ coverage: null, degraded: null });
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/ORDER BY created_at DESC/);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", 10]);

  mockSafeQuery.mockClear();
  await listScans("ws-1", 999);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", 50]); // capped
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
