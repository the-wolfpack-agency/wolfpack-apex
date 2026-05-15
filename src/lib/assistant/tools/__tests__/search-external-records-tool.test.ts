/**
 * Tests for search_external_records.
 *
 * Two surfaces:
 *   - matchIntent: every supported phrasing produces correct params;
 *     ID-shaped queries fall through to get_external_record.
 *   - handler: vendor routing, disambiguation UX (0 / 1 / many results),
 *     error mapping.
 */

const mockGetConnector = jest.fn();
const mockBuildRest = jest.fn();
const mockPickConfigured = jest.fn();
jest.mock("@/lib/assistant/connectors", () => ({
  getConnector: (...a: any[]) => mockGetConnector(...a),
  buildRestConnectorForWorkspace: (...a: any[]) => mockBuildRest(...a),
  pickConfiguredConnector: (...a: any[]) => mockPickConfigured(...a),
}));

import { searchExternalRecordsTool } from "@/lib/assistant/tools/search-external-records-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  mockGetConnector.mockReset();
  mockBuildRest.mockReset();
  mockPickConfigured.mockReset();
  mockPickConfigured.mockResolvedValue(null);
});

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

describe("matchIntent — name searches", () => {
  test.each([
    ["look up Grimace Fromcdonalds", "contact", "Grimace Fromcdonalds"],
    ["find Grimace Fromcdonalds", "contact", "Grimace Fromcdonalds"],
    ["search for McDonald's", "contact", "McDonald's"],
    ["who is Grimace Fromcdonalds?", "contact", "Grimace Fromcdonalds"],
    ["find the contact for Grimace Fromcdonalds", "contact", "Grimace Fromcdonalds"],
    ["look up account Acme Industries", "account", "Acme Industries"],
    ["find the opportunity called Q3 Renewal", "deal", "Q3 Renewal"],
    ["search for the company named Acme", "company", "Acme"],
  ])("'%s' → objectType=%s, query=%s", (msg, objectType, query) => {
    const p = searchExternalRecordsTool.matchIntent(msg);
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe(objectType);
    expect(p?.query).toBe(query);
  });
});

describe("matchIntent — email searches", () => {
  test.each([
    ["find grimace@mcdonalds.com", "grimace@mcdonalds.com"],
    ["look up someone with email user@host.io", "user@host.io"],
    ["who owns alice@example.org", "alice@example.org"],
  ])("'%s' → query=%s", (msg, query) => {
    const p = searchExternalRecordsTool.matchIntent(msg);
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("contact");
    expect(p?.query).toBe(query);
  });
});

describe("matchIntent — rejection (let get_external_record handle these)", () => {
  test.each([
    "look up contact id 003g500000GemUXAAZ",
    "fetch contact id ABC-123",
    "show me invoice INV-001",
    "get the deal record for 7HJ-99",
    "hi",
    "what's the weather",
  ])("'%s' → null", (msg) => {
    expect(searchExternalRecordsTool.matchIntent(msg)).toBeNull();
  });
});

describe("matchIntent — stopword stripping", () => {
  test("'find Grimace in salesforce' → query is 'Grimace' (no trailing stopwords)", () => {
    const p = searchExternalRecordsTool.matchIntent("find Grimace in salesforce");
    expect(p?.query).toBe("Grimace");
  });

  test("'look up Acme in our CRM' strips 'in our CRM'", () => {
    const p = searchExternalRecordsTool.matchIntent("look up Acme in our CRM");
    expect(p?.query).toBe("Acme");
  });
});

/* ---------------------------------------------------------------------
 * Handler
 * ------------------------------------------------------------------- */

describe("handler — connector auto-routing", () => {
  test("routes to workspace's configured salesforce connector when default rest-default given", async () => {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: async () => ({
        ok: true,
        data: [{ Id: "003a", Name: "Grimace Fromcdonalds", Email: "g@mc.com" }],
        durationMs: 12,
      }),
    });
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.connector).toBe("salesforce");
      expect(r.data.matchCount).toBe(1);
      expect(r.answer).toContain("Grimace Fromcdonalds");
    }
    expect(mockBuildRest).toHaveBeenCalledWith("ws1", "salesforce");
  });

  test("falls back to rest-default when no vendor row configured", async () => {
    mockPickConfigured.mockResolvedValueOnce(null);
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => false,
      searchRecords: async () => ({ ok: true, data: [], durationMs: 1 }),
    });
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("isn't configured");
  });
});

describe("handler — disambiguation UX", () => {
  function stubSearch(records: Array<Record<string, unknown>>): void {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: async () => ({ ok: true, data: records, durationMs: 5 }),
    });
  }

  test("0 results → 'No contact matches found'", async () => {
    stubSearch([]);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Nobody", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.matchCount).toBe(0);
      expect(r.answer).toContain("No contact matches found");
    }
  });

  test("1 result → full-record render with id + drill-in hint", async () => {
    stubSearch([
      { Id: "003a", Name: "Grimace Fromcdonalds", Email: "g@mc.com", Account: { Name: "Acme" } },
    ]);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toContain("Found 1");
      expect(r.answer).toContain("Grimace Fromcdonalds");
      expect(r.answer).toContain("g@mc.com");
      expect(r.answer).toContain("@ Acme");
      expect(r.answer).toContain("look up contact id 003a");
    }
  });

  test("3 results → numbered list with 'Reply with the number' hint", async () => {
    stubSearch([
      { Id: "001", Name: "Grimace One", Email: "1@x" },
      { Id: "002", Name: "Grimace Two", Email: "2@x" },
      { Id: "003", Name: "Grimace Three", Email: "3@x" },
    ]);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("Found 3 contacts");
    expect(r.answer).toContain("1. **Grimace One**");
    expect(r.answer).toContain("2. **Grimace Two**");
    expect(r.answer).toContain("3. **Grimace Three**");
    expect(r.answer).toContain("Reply with the number");
  });

  test(">5 results → top 5 + '5+ contacts' indicator", async () => {
    const records = Array.from({ length: 8 }, (_, i) => ({
      Id: `00${i}`,
      Name: `Grimace ${i}`,
      Email: `${i}@x.com`,
    }));
    stubSearch(records);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("8+ contacts");
    /* Only first 5 are rendered. */
    expect(r.answer).toContain("Grimace 4");
    expect(r.answer).not.toContain("Grimace 5");
  });
});

describe("handler — error mapping", () => {
  test("auth_failed from connector → tool capability failure", async () => {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: async () => ({
        ok: false,
        code: "auth_failed",
        message: "HTTP 401",
        durationMs: 5,
      }),
    });
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });

  test("remote_error from connector → tool internal failure", async () => {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: async () => ({
        ok: false,
        code: "remote_error",
        message: "HTTP 500",
        durationMs: 5,
      }),
    });
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "x", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });

  test("unregistered explicit connector → internal failure", async () => {
    mockGetConnector.mockReturnValueOnce(null);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "x", connector: "ghost" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

describe("handler — record formatting per object type", () => {
  test("deal renders stage + amount", async () => {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: async () => ({
        ok: true,
        data: [{ Id: "006abc", Name: "Q3 Renewal", StageName: "Proposal", Amount: 50000 }],
        durationMs: 5,
      }),
    });
    const r = await searchExternalRecordsTool.handler(
      { objectType: "deal", query: "Q3", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("Q3 Renewal");
    expect(r.answer).toContain("Proposal");
    expect(r.answer).toContain("$50000");
  });

  test("account renders industry + phone", async () => {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: async () => ({
        ok: true,
        data: [{ Id: "001abc", Name: "Acme Industries", Industry: "Manufacturing", Phone: "555-1234" }],
        durationMs: 5,
      }),
    });
    const r = await searchExternalRecordsTool.handler(
      { objectType: "account", query: "Acme", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("Acme Industries");
    expect(r.answer).toContain("Manufacturing");
    expect(r.answer).toContain("555-1234");
  });
});
