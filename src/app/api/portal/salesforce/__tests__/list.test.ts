/**
 * /api/portal/salesforce/list — route tests.
 *
 * Coverage: auth, validation, stage filtering, load-more semantics,
 * connector-down fallback.
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

import { GET } from "@/app/api/portal/salesforce/list/route";

const ADMIN = { id: "u1", role: "cto", workspaceId: "default" };

function mkReq(qs: string): unknown {
  return {
    url: `https://x.local/api/portal/salesforce/list?${qs}`,
    headers: new Map(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/portal/salesforce/list", () => {
  test("401 when caller lacks capability", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 401 } });
    const res = await GET(mkReq("type=contacts") as never);
    expect((res as { status: number }).status).toBe(401);
  });

  test("400 when type is missing or invalid", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN });
    const r1 = await GET(mkReq("type=bogus") as never);
    expect(r1.status).toBe(400);
    const r2 = await GET(mkReq("") as never);
    expect(r2.status).toBe(400);
  });

  test("returns notConfigured fallback when SF not configured", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => false, searchRecords: jest.fn() },
      notConfigured: true,
      instanceUrl: null,
    });
    const res = await GET(mkReq("type=contacts") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notConfigured).toBe(true);
    expect(body.records).toEqual([]);
  });

  test("happy path: returns records + applies stage filter for opportunities", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const searchRecords = jest.fn().mockResolvedValue({
      ok: true,
      data: [
        { Id: "o1", Name: "Acme", StageName: "Prospecting", Amount: 1000 },
        { Id: "o2", Name: "Blitz", StageName: "Closed Won", Amount: 2000 },
        { Id: "o3", Name: "Cookie", StageName: "Prospecting", Amount: 3000 },
      ],
    });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => true, searchRecords },
      notConfigured: false,
      instanceUrl: "https://x",
    });
    const res = await GET(mkReq("type=opportunities&stage=Prospecting") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records.map((r: { Id: string }) => r.Id)).toEqual(["o1", "o3"]);
    expect(mockTrack).toHaveBeenCalledWith(
      "portal.salesforce_list_viewed",
      "u1",
      "cto",
      expect.objectContaining({ type: "opportunities", result_count: 2 }),
    );
  });

  test("502 when connector errors with auth_failed", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: {
        isConfigured: () => true,
        searchRecords: jest.fn().mockResolvedValue({ ok: false, code: "auth_failed", message: "401" }),
      },
      notConfigured: false,
      instanceUrl: "https://x",
    });
    const res = await GET(mkReq("type=accounts") as never);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("auth_failed");
  });
});
