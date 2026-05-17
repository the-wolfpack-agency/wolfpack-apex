/**
 * describeCrmObject — live + fallback paths, vendor-specific
 * extraction.
 */

const mockLoadCreds = jest.fn();
const mockGetTemplate = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (...a: unknown[]) => mockLoadCreds(...a),
}));
jest.mock("@/lib/templates/registry", () => ({
  getIntegrationTemplate: (...a: unknown[]) => mockGetTemplate(...a),
}));

(global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import { describeCrmObject } from "@/lib/integrations/describe-crm";

beforeEach(() => {
  mockLoadCreds.mockReset();
  mockGetTemplate.mockReset();
  mockFetch.mockReset();
});

describe("describeCrmObject — Salesforce", () => {
  test("live describe returns normalized field set", async () => {
    mockLoadCreds.mockResolvedValue({
      isActive: true,
      baseUrl: "https://wolfpack.my.salesforce.com",
      authHeader: "Bearer t",
    });
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        fields: [
          { name: "Name", type: "string", nillable: false, defaultedOnCreate: false, label: "Account Name", length: 200 },
          { name: "StageName", type: "picklist", nillable: false, defaultedOnCreate: false, picklistValues: [
            { active: true, value: "Prospecting", label: "Prospecting" },
            { active: true, value: "Closed Won", label: "Closed Won" },
          ] },
          { name: "Amount", type: "currency", nillable: true, defaultedOnCreate: false },
          { name: "OldField", type: "string", nillable: true, defaultedOnCreate: true },
        ],
      }),
    });
    const r = await describeCrmObject("salesforce", "deal", "ws1");
    expect(r.source).toBe("live");
    /* StageName required (nillable=false, defaultedOnCreate=false). */
    const stage = r.fields.find((f) => f.name === "StageName");
    expect(stage?.required).toBe(true);
    expect(stage?.type).toBe("select");
    expect(stage?.options).toEqual([
      { value: "Prospecting", label: "Prospecting" },
      { value: "Closed Won", label: "Closed Won" },
    ]);
    /* Amount nillable → not required. */
    expect(r.fields.find((f) => f.name === "Amount")?.required).toBe(false);
    /* maxLength forwarded from `length`. */
    expect(r.fields.find((f) => f.name === "Name")?.maxLength).toBe(200);
  });

  test("falls back to template when describe 401's", async () => {
    mockLoadCreds.mockResolvedValue({ isActive: true, baseUrl: "https://x", authHeader: "Bearer t" });
    mockFetch.mockResolvedValue({ status: 401, json: async () => ({}) });
    mockGetTemplate.mockResolvedValue({
      fallbackFieldSet: [
        { name: "Name", required: true },
        { name: "StageName", required: true },
      ],
      lastKnownSchemaHash: "hash-frozen",
    });
    const r = await describeCrmObject("salesforce", "deal", "ws1");
    expect(r.source).toBe("fallback");
    expect(r.fields.map((f) => f.name)).toEqual(["Name", "StageName"]);
    expect(r.schemaHash).toBe("hash-frozen");
  });

  test("falls back when no credentials are configured", async () => {
    mockLoadCreds.mockResolvedValue(null);
    mockGetTemplate.mockResolvedValue({
      fallbackFieldSet: [{ name: "Name", required: true }],
      lastKnownSchemaHash: null,
    });
    const r = await describeCrmObject("salesforce", "deal", "ws1");
    expect(r.source).toBe("fallback");
    expect(r.fields).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("source=none when both live + template miss", async () => {
    mockLoadCreds.mockResolvedValue(null);
    mockGetTemplate.mockResolvedValue(null);
    const r = await describeCrmObject("salesforce", "deal", "ws1");
    expect(r.source).toBe("none");
    expect(r.fields).toEqual([]);
  });
});

describe("describeCrmObject — HubSpot", () => {
  test("normalizes results[] into fields[]", async () => {
    mockLoadCreds.mockResolvedValue({ isActive: true, baseUrl: "https://api.hubapi.com", authHeader: "Bearer t" });
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        results: [
          { name: "dealname", type: "string", label: "Deal name" },
          { name: "amount", type: "number", label: "Amount" },
          { name: "dealstage", type: "enumeration", label: "Deal stage", options: [
            { value: "qualifiedtobuy", label: "Qualified" },
            { value: "closedwon", label: "Closed (won)" },
          ] },
        ],
      }),
    });
    const r = await describeCrmObject("hubspot", "deal", "ws1");
    expect(r.source).toBe("live");
    expect(r.fields.map((f) => f.name)).toEqual(["dealname", "amount", "dealstage"]);
    expect(r.fields.find((f) => f.name === "dealstage")?.type).toBe("select");
    expect(r.fields.find((f) => f.name === "dealstage")?.options).toHaveLength(2);
  });

  test("empty results triggers fallback", async () => {
    mockLoadCreds.mockResolvedValue({ isActive: true, baseUrl: "https://api.hubapi.com", authHeader: "Bearer t" });
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({ results: [] }) });
    mockGetTemplate.mockResolvedValue({
      fallbackFieldSet: [{ name: "dealname", required: true }],
      lastKnownSchemaHash: null,
    });
    const r = await describeCrmObject("hubspot", "deal", "ws1");
    expect(r.source).toBe("fallback");
  });
});

describe("describeCrmObject — error tolerance", () => {
  test("network error falls back, never throws", async () => {
    mockLoadCreds.mockResolvedValue({ isActive: true, baseUrl: "https://x", authHeader: "Bearer t" });
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    mockGetTemplate.mockResolvedValue({ fallbackFieldSet: [], lastKnownSchemaHash: null });
    const r = await describeCrmObject("salesforce", "deal", "ws1");
    expect(r.source).toBe("none");
  });
});
