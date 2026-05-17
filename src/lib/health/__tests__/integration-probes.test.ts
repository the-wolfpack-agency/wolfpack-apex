/**
 * Integration health probe lib — hash stability, vendor dispatch,
 * failure modes, persistence.
 *
 * Mocks every external surface so the suite stays deterministic +
 * doesn't hit real Graph/Salesforce/HubSpot endpoints.
 */

const mockSafeQuery = jest.fn();
const mockGetMsStatus = jest.fn();
const mockGetValidToken = jest.fn();
const mockGraphFetch = jest.fn();
const mockGetQboStatus = jest.fn();
const mockLoadConnectorCreds = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getConnectionStatus: (...a: unknown[]) => mockGetMsStatus(...a),
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
  graphFetch: (...a: unknown[]) => mockGraphFetch(...a),
}));
jest.mock("@/lib/quickbooks", () => ({
  getConnectionStatus: (...a: unknown[]) => mockGetQboStatus(...a),
}));
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (...a: unknown[]) => mockLoadConnectorCreds(...a),
}));

(global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import {
  hashSchema,
  runProbe,
  persistProbeResult,
  getLastKnownGoodHash,
} from "@/lib/health/integration-probes";

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockGetMsStatus.mockReset();
  mockGetValidToken.mockReset();
  mockGraphFetch.mockReset();
  mockGetQboStatus.mockReset();
  mockLoadConnectorCreds.mockReset();
  mockFetch.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});

describe("hashSchema", () => {
  test("is stable across key reorderings", () => {
    expect(hashSchema({ a: 1, b: 2 })).toBe(hashSchema({ b: 2, a: 1 }));
  });
  test("differs when a field is added", () => {
    expect(hashSchema({ fields: ["a", "b"] })).not.toBe(
      hashSchema({ fields: ["a", "b", "c"] }),
    );
  });
  test("is deterministic on nested objects", () => {
    const a = hashSchema({ list: [{ name: "x", type: "string" }] });
    const b = hashSchema({ list: [{ type: "string", name: "x" }] });
    expect(a).toBe(b);
  });
});

describe("runProbe — Microsoft connectivity", () => {
  test("ok when status.connected = true", async () => {
    mockGetMsStatus.mockResolvedValue({ connected: true, mode: "live" });
    const r = await runProbe("microsoft", "connectivity", { workspaceId: "ws", userId: "u1" });
    expect(r.ok).toBe(true);
    expect(r.vendor).toBe("microsoft");
  });
  test("not ok when disconnected", async () => {
    mockGetMsStatus.mockResolvedValue({ connected: false });
    const r = await runProbe("microsoft", "connectivity", { workspaceId: "ws", userId: "u1" });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Not connected/);
  });
  test("requires userId", async () => {
    const r = await runProbe("microsoft", "connectivity", { workspaceId: "ws" });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/userId/);
  });
  test("captures thrown errors as non-ok", async () => {
    mockGetMsStatus.mockRejectedValue(new Error("Graph 503"));
    const r = await runProbe("microsoft", "connectivity", { workspaceId: "ws", userId: "u1" });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Graph 503/);
  });
});

describe("runProbe — Microsoft schema (task)", () => {
  test("hashes the field set of the first row", async () => {
    mockGetValidToken.mockResolvedValue({ accessToken: "xxx" });
    mockGraphFetch.mockResolvedValue({
      value: [{ id: "list-1", displayName: "Tasks", wellknownListName: "defaultList" }],
    });
    const r = await runProbe("microsoft", "schema", { workspaceId: "ws", userId: "u1" }, "task");
    expect(r.ok).toBe(true);
    expect(r.schemaHash).toBeTruthy();
    expect((r.schemaPayload as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(["id", "displayName", "wellknownListName"]),
    );
  });
  test("returns ok=false when token missing", async () => {
    mockGetValidToken.mockResolvedValue(null);
    const r = await runProbe("microsoft", "schema", { workspaceId: "ws", userId: "u1" }, "task");
    expect(r.ok).toBe(false);
  });
});

describe("runProbe — CRM connectivity", () => {
  test("Salesforce: hits /services/data/v59.0/sobjects, ok on 2xx", async () => {
    mockLoadConnectorCreds.mockResolvedValue({
      isActive: true,
      baseUrl: "https://wolfpack.my.salesforce.com",
      authHeader: "Bearer token",
    });
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({}) });
    const r = await runProbe("salesforce", "connectivity", { workspaceId: "ws" });
    expect(r.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/services/data/v59.0/sobjects"),
      expect.any(Object),
    );
  });
  test("HubSpot: hits /crm/v3/objects/companies, fails on 401", async () => {
    mockLoadConnectorCreds.mockResolvedValue({
      isActive: true,
      baseUrl: "https://api.hubapi.com",
      authHeader: "Bearer token",
    });
    mockFetch.mockResolvedValue({ status: 401, json: async () => ({}) });
    const r = await runProbe("hubspot", "connectivity", { workspaceId: "ws" });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.errorMessage).toMatch(/HTTP 401/);
  });
  test("not ok when no active credentials", async () => {
    mockLoadConnectorCreds.mockResolvedValue(null);
    const r = await runProbe("salesforce", "connectivity", { workspaceId: "ws" });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/No active credentials/);
  });
});

describe("runProbe — CRM schema drift hash", () => {
  test("Salesforce describe → hashes name/type/required of each field", async () => {
    mockLoadConnectorCreds.mockResolvedValue({
      isActive: true,
      baseUrl: "https://wolfpack.my.salesforce.com",
      authHeader: "Bearer token",
    });
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        fields: [
          { name: "Name", type: "string", nillable: false, defaultedOnCreate: false },
          { name: "StageName", type: "picklist", nillable: false, defaultedOnCreate: false },
          { name: "Amount", type: "currency", nillable: true, defaultedOnCreate: false },
        ],
      }),
    });
    const r = await runProbe("salesforce", "schema", { workspaceId: "ws" }, "deal");
    expect(r.ok).toBe(true);
    const fields = r.schemaPayload as Array<{ name: string; required: boolean }>;
    expect(fields).toEqual([
      { name: "Amount", type: "currency", required: false },
      { name: "Name", type: "string", required: true },
      { name: "StageName", type: "picklist", required: true },
    ]);
    expect(r.schemaHash).toBeTruthy();
  });

  test("adding a field to Salesforce describe produces a different hash", async () => {
    mockLoadConnectorCreds.mockResolvedValue({
      isActive: true,
      baseUrl: "https://wolfpack.my.salesforce.com",
      authHeader: "Bearer token",
    });
    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          fields: [{ name: "Name", type: "string", nillable: false, defaultedOnCreate: false }],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          fields: [
            { name: "Name", type: "string", nillable: false, defaultedOnCreate: false },
            { name: "NewField__c", type: "string", nillable: false, defaultedOnCreate: false },
          ],
        }),
      });
    const before = await runProbe("salesforce", "schema", { workspaceId: "ws" }, "deal");
    const after = await runProbe("salesforce", "schema", { workspaceId: "ws" }, "deal");
    expect(before.schemaHash).not.toBe(after.schemaHash);
  });

  test("HubSpot results array → field list extraction", async () => {
    mockLoadConnectorCreds.mockResolvedValue({
      isActive: true,
      baseUrl: "https://api.hubapi.com",
      authHeader: "Bearer token",
    });
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        results: [
          { name: "dealname", type: "string" },
          { name: "amount", type: "number" },
        ],
      }),
    });
    const r = await runProbe("hubspot", "schema", { workspaceId: "ws" }, "deal");
    expect(r.ok).toBe(true);
    const fields = r.schemaPayload as Array<{ name: string }>;
    expect(fields.map((f) => f.name)).toEqual(["amount", "dealname"]);
  });
});

describe("runProbe — vendor dispatch", () => {
  test("unknown vendor returns ok=false", async () => {
    const r = await runProbe("unknown", "connectivity", { workspaceId: "ws" });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Unknown vendor/);
  });
  test("action probe stub returns not-yet-wired message", async () => {
    const r = await runProbe("salesforce", "action", { workspaceId: "ws" }, "deal");
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Action probes/);
  });
});

describe("persistProbeResult", () => {
  test("inserts into integration_health with truncated payload", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await persistProbeResult("ws", {
      vendor: "salesforce",
      probeKind: "schema",
      objectType: "deal",
      ok: true,
      schemaHash: "abc",
      schemaPayload: [{ name: "x", type: "string" }],
      durationMs: 42,
    });
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO integration_health"),
      expect.arrayContaining(["ws", "salesforce", "schema", "deal", true]),
    );
  });
  test("noop when DATABASE_URL not set", async () => {
    delete process.env.DATABASE_URL;
    await persistProbeResult("ws", {
      vendor: "salesforce",
      probeKind: "connectivity",
      ok: true,
      durationMs: 10,
    });
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("getLastKnownGoodHash", () => {
  test("returns hash from latest ok schema row", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ schema_hash: "abc123" }] });
    const h = await getLastKnownGoodHash("ws", "salesforce", "deal");
    expect(h).toBe("abc123");
  });
  test("returns null when no rows", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const h = await getLastKnownGoodHash("ws", "salesforce", "deal");
    expect(h).toBeNull();
  });
  test("returns null on DB error", async () => {
    mockSafeQuery.mockRejectedValue(new Error("DB down"));
    const h = await getLastKnownGoodHash("ws", "salesforce", "deal");
    expect(h).toBeNull();
  });
});
