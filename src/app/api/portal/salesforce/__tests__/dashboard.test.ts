/**
 * /api/portal/salesforce/dashboard — route tests.
 *
 * Coverage:
 *   - 401 when caller lacks capability
 *   - 200 + notConfigured=true when no SF connector configured
 *   - 200 + pipeline aggregation when configured
 *   - 502 surfaces from connector auth_failed
 *
 * Pattern matches src/app/api/admin/connectors/__tests__/route.test.ts —
 * mock the capability gate + the connector resolver + the analytics
 * fire-and-forget so the route code is tested in isolation.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockResolve = jest.fn();
jest.mock("../_helpers", () => {
  const original = jest.requireActual("../_helpers");
  return {
    ...original,
    resolveSalesforceConnector: (...a: unknown[]) => mockResolve(...a),
  };
});

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

import { GET } from "@/app/api/portal/salesforce/dashboard/route";

const ADMIN = { id: "u1", role: "cto", workspaceId: "default" };

function mkReq(): unknown {
  return {
    url: "https://x.local/api/portal/salesforce/dashboard",
    headers: new Map(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/portal/salesforce/dashboard", () => {
  test("401 when caller lacks capability", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: { status: 401 },
    });
    const res = await GET(mkReq() as never);
    expect((res as { status: number }).status).toBe(401);
  });

  test("returns notConfigured=true with empty pipeline when SF not configured", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => false, searchRecords: jest.fn() },
      notConfigured: true,
      instanceUrl: null,
    });
    const res = await GET(mkReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notConfigured).toBe(true);
    expect(body.pipeline.openCount).toBe(0);
    expect(body.recent).toEqual([]);
  });

  test("aggregates pipeline + recent activity when connector returns rows", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const searchRecords = jest.fn().mockImplementation(async (type: string) => {
      if (type === "opportunity") {
        return {
          ok: true,
          data: [
            { Id: "o1", Name: "Acme Q3", StageName: "Prospecting", Amount: 50000, LastModifiedDate: "2026-05-19T00:00:00Z" },
            { Id: "o2", Name: "Acme Q4", StageName: "Closed Won", Amount: 100000, LastModifiedDate: "2026-05-18T00:00:00Z" },
            { Id: "o3", Name: "Blitz", StageName: "Prospecting", Amount: 25000, LastModifiedDate: "2026-05-17T00:00:00Z" },
          ],
        };
      }
      if (type === "contact") {
        return { ok: true, data: [{ Id: "c1", Name: "Jane", LastModifiedDate: "2026-05-19T01:00:00Z" }] };
      }
      return { ok: true, data: [{ Id: "a1", Name: "Acme", LastModifiedDate: "2026-05-19T02:00:00Z" }] };
    });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => true, searchRecords },
      notConfigured: false,
      instanceUrl: "https://acme.my.salesforce.com",
    });

    const res = await GET(mkReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notConfigured).toBe(false);
    /* Open count = opps NOT in Closed Won/Lost = 2 (o1 + o3). */
    expect(body.pipeline.openCount).toBe(2);
    expect(body.pipeline.totalAmount).toBe(75000);
    expect(body.pipeline.byStage.length).toBeGreaterThan(0);
    /* Recent activity sorted desc by LastModifiedDate — account "a1" leads. */
    expect(body.recent[0].id).toBe("a1");
    expect(body.recent[0].type).toBe("accounts");
    /* Analytics fired with configured=true. */
    expect(mockTrack).toHaveBeenCalledWith(
      "portal.salesforce_dashboard_viewed",
      "u1",
      "cto",
      expect.objectContaining({ configured: true, open_count: 2 }),
    );
  });

  test("502 when connector returns auth_failed", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: {
        isConfigured: () => true,
        searchRecords: jest.fn().mockResolvedValue({ ok: false, code: "auth_failed", message: "401" }),
      },
      notConfigured: false,
      instanceUrl: "https://x.salesforce.com",
    });
    const res = await GET(mkReq() as never);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("auth_failed");
  });
});
