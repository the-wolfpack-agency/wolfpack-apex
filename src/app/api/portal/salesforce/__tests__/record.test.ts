/**
 * /api/portal/salesforce/record — route tests.
 *
 * Coverage: GET / PATCH / POST × auth, validation, allowed fields,
 * not-configured fallback, connector errors, success paths.
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

import { GET, PATCH, POST } from "@/app/api/portal/salesforce/record/route";

const ADMIN = { id: "u1", role: "cto", workspaceId: "default" };

function mkGetReq(qs: string): unknown {
  return {
    url: `https://x.local/api/portal/salesforce/record?${qs}`,
    headers: new Map(),
  };
}
function mkWriteReq(body: unknown): unknown {
  return {
    url: "https://x.local/api/portal/salesforce/record",
    headers: new Map(),
    json: async () => body,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/portal/salesforce/record", () => {
  test("401 without capability", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 401 } });
    const res = await GET(mkGetReq("type=contacts&id=003") as never);
    expect((res as { status: number }).status).toBe(401);
  });

  test("400 when type/id invalid", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN });
    const r1 = await GET(mkGetReq("type=bogus&id=003") as never);
    expect(r1.status).toBe(400);
    const r2 = await GET(mkGetReq("type=contacts") as never);
    expect(r2.status).toBe(400);
  });

  test("happy GET returns record + instanceUrl + fires analytics", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => true, getRecord: jest.fn().mockResolvedValue({ ok: true, data: { Id: "003abc", Name: "Jane" } }) },
      notConfigured: false,
      instanceUrl: "https://acme.my.salesforce.com",
    });
    const res = await GET(mkGetReq("type=contacts&id=003abc") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record.Name).toBe("Jane");
    expect(body.instanceUrl).toContain("salesforce.com");
    expect(mockTrack).toHaveBeenCalledWith(
      "portal.salesforce_record_viewed",
      "u1",
      "cto",
      expect.objectContaining({ type: "contacts" }),
    );
  });

  test("notConfigured fallback returns empty record", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => false, getRecord: jest.fn() },
      notConfigured: true,
      instanceUrl: null,
    });
    const res = await GET(mkGetReq("type=contacts&id=003abc") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notConfigured).toBe(true);
  });

  test("not_found from connector becomes 404", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => true, getRecord: jest.fn().mockResolvedValue({ ok: false, code: "not_found" }) },
      notConfigured: false,
      instanceUrl: "https://x",
    });
    const res = await GET(mkGetReq("type=contacts&id=003abc") as never);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/portal/salesforce/record", () => {
  test("401 without capability", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 401 } });
    const res = await PATCH(mkWriteReq({}) as never);
    expect((res as { status: number }).status).toBe(401);
  });

  test("400 on unknown field name (allow-list enforced)", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await PATCH(mkWriteReq({ type: "contacts", id: "003abc", field: "SecretField", value: "hack" }) as never);
    expect(res.status).toBe(400);
  });

  test("412 when SF not configured", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => false, updateRecord: jest.fn() },
      notConfigured: true,
      instanceUrl: null,
    });
    const res = await PATCH(mkWriteReq({ type: "contacts", id: "003abc", field: "Phone", value: "555" }) as never);
    expect(res.status).toBe(412);
  });

  test("happy PATCH writes single field + fires analytics", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const updateRecord = jest.fn().mockResolvedValue({ ok: true, data: { id: "003abc" } });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => true, updateRecord },
      notConfigured: false,
      instanceUrl: "https://x",
    });
    const res = await PATCH(mkWriteReq({ type: "contacts", id: "003abc", field: "Phone", value: "555-0101" }) as never);
    expect(res.status).toBe(200);
    expect(updateRecord).toHaveBeenCalledWith("contact", "003abc", { Phone: "555-0101" });
    expect(mockTrack).toHaveBeenCalledWith(
      "portal.salesforce_record_updated",
      "u1",
      "cto",
      expect.objectContaining({ type: "contacts", field: "Phone" }),
    );
  });
});

describe("POST /api/portal/salesforce/record", () => {
  test("401 without capability", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 401 } });
    const res = await POST(mkWriteReq({}) as never);
    expect((res as { status: number }).status).toBe(401);
  });

  test("400 when fields object empty / missing", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN });
    const r1 = await POST(mkWriteReq({ type: "contacts", fields: {} }) as never);
    expect(r1.status).toBe(400);
    const r2 = await POST(mkWriteReq({ type: "contacts" }) as never);
    expect(r2.status).toBe(400);
  });

  test("400 on unknown field in body", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(mkWriteReq({ type: "contacts", fields: { Bogus: "x" } }) as never);
    expect(res.status).toBe(400);
  });

  test("happy POST creates record + fires analytics", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const createRecord = jest.fn().mockResolvedValue({ ok: true, data: { id: "003new" } });
    mockResolve.mockResolvedValueOnce({
      connectorName: "salesforce",
      connector: { isConfigured: () => true, createRecord },
      notConfigured: false,
      instanceUrl: "https://x",
    });
    const res = await POST(
      mkWriteReq({ type: "contacts", fields: { LastName: "Doe", Email: "j@e.com" } }) as never,
    );
    expect(res.status).toBe(200);
    expect(createRecord).toHaveBeenCalledWith("contact", { LastName: "Doe", Email: "j@e.com" });
    const body = await res.json();
    expect(body.id).toBe("003new");
    expect(mockTrack).toHaveBeenCalledWith(
      "portal.salesforce_record_created",
      "u1",
      "cto",
      expect.objectContaining({ type: "contacts" }),
    );
  });
});
