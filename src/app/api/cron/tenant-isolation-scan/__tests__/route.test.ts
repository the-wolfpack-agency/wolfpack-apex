/**
 * Contract tests for GET /api/cron/tenant-isolation-scan.
 *
 * Locks the two auth paths (CRON_SECRET bearer vs admin capability vs 401), the
 * analytics emit (`system.tenant_isolation_scanned` with the coverage metric),
 * the durable snapshot insert, and the body shape. No DB / no network — the
 * baseline JSON and db/analytics layers are mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock(
  "@/lib/db/__generated__/tenant-isolation-baseline.json",
  () => ({
    scopedTableCount: 37,
    scopedTables: [],
    enforcedTableCount: 0,
    enforcedTables: [],
    totalOffenders: 78,
    counts: { "principal-resolve": 52, "pk-pinned-upstream": 10, unclassified: 0 },
    unclassifiedCount: 0,
  }),
  { virtual: true },
);

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

function makeReq(authHeader?: string): NextRequest {
  return new NextRequest("https://x.test/api/cron/tenant-isolation-scan", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [] }); // insert succeeds
  delete process.env.CRON_SECRET;
});

describe("GET /api/cron/tenant-isolation-scan", () => {
  it("401s when there is neither a valid cron secret nor an authorized session", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("cron path: records the snapshot + emits the coverage event as the system actor", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(makeReq("Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      recorded: true,
      scopedTables: 37,
      totalOffenders: 78,
      unclassified: 0,
      source: "cron",
    });

    // Analytics: the event carries the metric + flattened per-class counts.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.tenant_isolation_scanned",
      "cron",
      "system",
      expect.objectContaining({
        scoped_tables: 37,
        rls_enforced_tables: 0,
        rls_tripwire_tables: 37,
        total_offenders: 78,
        unclassified: 0,
        source: "cron",
        class_principal_resolve: 52,
        class_pk_pinned_upstream: 10,
      }),
    );

    // Durable row written to the coverage ledger.
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, args] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_tenant_isolation_scans/i);
    expect(args[0]).toMatch(/^tis_/); // opaque TEXT id
    expect(args).toEqual([expect.any(String), 37, 78, 0, expect.any(String), "cron"]);
    // requireCapability is NOT consulted on the cron path.
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("a wrong bearer falls through to the capability gate (no secret bypass)", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await GET(makeReq("Bearer WRONG"));
    expect(res.status).toBe(403);
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });

  it("manual path: an authorized admin records the snapshot attributed to them", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: { id: "u-admin", role: "admin", workspaceId: "w-1" },
      capabilities: new Set(),
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("manual");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.tenant_isolation_scanned",
      "u-admin",
      "admin",
      expect.objectContaining({ source: "manual" }),
    );
  });

  it("does not throw when the snapshot insert fails (best-effort telemetry)", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockSafeQuery.mockResolvedValue(null); // degraded DB
    const res = await GET(makeReq("Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(false);
    expect(body.ok).toBe(true);
  });
});
