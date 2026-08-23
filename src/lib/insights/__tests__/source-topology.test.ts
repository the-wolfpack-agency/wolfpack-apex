/**
 * What we can tell a client before they have used us for anything.
 *
 * The suite is organised around the two failure modes that would make
 * these generators worthless in a pitch: saying something that needed
 * history (so it is blank on day one), and saying something we cannot
 * back up with arithmetic (so it collapses the first time a sharp
 * engineer asks how we know).
 */

export {};

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: any[]) => mockQuery(...a) }));

const mockList = jest.fn();
jest.mock("@/lib/assistant/connectors/registry", () => ({
  listConnectors: () => mockList(),
  /* rest-connector self-registers at import; the fingerprint tests
     import it for real, so the registry mock has to keep that call
     working rather than replace the module with one function. */
  registerConnector: jest.fn(),
  getConnector: jest.fn(),
}));

const CTX = { userId: "u1", userRole: "admin", lookbackDays: 7 };
const ORIGINAL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

function connector(name: string, objectTypes: string[], configured = true) {
  return {
    name,
    description: name,
    isConfigured: () => configured,
    objectTypes: () => objectTypes,
    getRecord: jest.fn(),
    searchRecords: jest.fn(),
  };
}

describe("cross-source overlap — the day-zero insight", () => {
  it("says nothing with only one system connected", async () => {
    /* One system cannot disagree with anything. Inventing a finding
       here would be the exact demo-shaped behaviour we refuse. */
    mockList.mockReturnValue([connector("hubspot", ["contact", "deal"])]);
    const { generateCrossSourceOverlap } = await import("../source-topology");
    expect(await generateCrossSourceOverlap(CTX)).toEqual([]);
  });

  it("names the shared entity the moment a second system is connected", async () => {
    mockList.mockReturnValue([
      connector("hubspot", ["contact", "deal"]),
      connector("legacy-dms", ["contact", "vehicle"]),
    ]);
    const { generateCrossSourceOverlap } = await import("../source-topology");
    const out = await generateCrossSourceOverlap(CTX);

    const contact = out.find((i) => i.id === "cross_source_overlap:contact");
    expect(contact).toBeDefined();
    expect(contact!.sources.sort()).toEqual(["hubspot", "legacy-dms"]);
    /* deal and vehicle live in one system each — not an overlap. */
    expect(out.map((i) => i.id)).not.toContain("cross_source_overlap:deal");
    expect(out.map((i) => i.id)).not.toContain("cross_source_overlap:vehicle");
  });

  it("needs no database, no events, and no prior usage", async () => {
    /* The point of the generator. If it ever touches the DB it has
       become another generator that is blank on the first day. */
    delete process.env.DATABASE_URL;
    mockList.mockReturnValue([
      connector("a", ["contact"]),
      connector("b", ["contact"]),
    ]);
    const { generateCrossSourceOverlap } = await import("../source-topology");
    expect(await generateCrossSourceOverlap(CTX)).toHaveLength(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("ignores a system that is registered but not configured", async () => {
    mockList.mockReturnValue([
      connector("hubspot", ["contact"]),
      connector("salesforce", ["contact"], false),
    ]);
    const { generateCrossSourceOverlap } = await import("../source-topology");
    expect(await generateCrossSourceOverlap(CTX)).toEqual([]);
  });

  it("survives a connector whose isConfigured throws", async () => {
    const broken: any = connector("broken", ["contact"]);
    broken.isConfigured = () => {
      throw new Error("credentials store unreachable");
    };
    mockList.mockReturnValue([
      broken,
      connector("a", ["contact"]),
      connector("b", ["contact"]),
    ]);
    const { generateCrossSourceOverlap } = await import("../source-topology");
    const out = await generateCrossSourceOverlap(CTX);
    expect(out[0].sources).toEqual(["a", "b"]);
  });

  it("ranks a three-system overlap above a two-system one", async () => {
    mockList.mockReturnValue([
      connector("a", ["contact", "deal"]),
      connector("b", ["contact", "deal"]),
      connector("c", ["contact"]),
    ]);
    const { generateCrossSourceOverlap } = await import("../source-topology");
    const out = await generateCrossSourceOverlap(CTX);
    expect(out[0].id).toBe("cross_source_overlap:contact");
    expect(out[0].signalStrength).toBeGreaterThan(out[1].signalStrength);
  });
});

describe("redundant source reads — the compute a client is paying for twice", () => {
  it("reports the extra calls, not the total", async () => {
    /* Four identical calls in a window is three wasted, not four. A
       number a client can check is the only kind worth showing. */
    mockQuery.mockResolvedValue({
      rows: [
        {
          connector: "legacy-dms",
          object_type: "contact",
          operation: "getRecord",
          repeats: 31,
          total_ms: 24_000,
          buckets: 9,
        },
      ],
    });
    const { generateRedundantSourceReads } = await import("../source-topology");
    const [insight] = await generateRedundantSourceReads(CTX);
    expect(insight.title).toContain("31 extra times");
    expect(insight.detail).toContain("24s");
    expect(insight.sources).toEqual(["legacy-dms"]);
  });

  it("only counts repeats inside a short window, so a steady poll is not waste", async () => {
    /* Bucketing is what separates 'a system in use' from 'a system
       asked the same thing twice'. Asserted on the SQL because the
       distinction lives there and nowhere else. */
    mockQuery.mockResolvedValue({ rows: [] });
    const { generateRedundantSourceReads } = await import("../source-topology");
    await generateRedundantSourceReads(CTX);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/GROUP BY connector, fingerprint, bucket/);
    expect(String(sql)).toMatch(/HAVING COUNT\(\*\) >= \$3/);
    expect(params[1]).toBe(10);
    expect(params[2]).toBe(4);
  });

  it("never reads the request itself — only the hash", async () => {
    /* The whole design rests on this. A query that could select the
       path would be storing the client's customer names in our
       analytics table. */
    mockQuery.mockResolvedValue({ rows: [] });
    const { generateRedundantSourceReads } = await import("../source-topology");
    await generateRedundantSourceReads(CTX);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/metadata->>'fingerprint'/);
    expect(sql).not.toMatch(/'path'|'url'|'query'/);
  });

  it("scales severity with the size of the saving", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { connector: "big", object_type: "deal", operation: "searchRecords", repeats: 80, total_ms: 90_000, buckets: 20 },
        { connector: "mid", object_type: "deal", operation: "searchRecords", repeats: 20, total_ms: 9_000, buckets: 5 },
        { connector: "small", object_type: "deal", operation: "searchRecords", repeats: 5, total_ms: 900, buckets: 2 },
      ],
    });
    const { generateRedundantSourceReads } = await import("../source-topology");
    const out = await generateRedundantSourceReads(CTX);
    expect(out.map((i) => i.severity)).toEqual(["high", "medium", "low"]);
  });

  it("returns nothing rather than throwing when there is no database", async () => {
    delete process.env.DATABASE_URL;
    const { generateRedundantSourceReads } = await import("../source-topology");
    expect(await generateRedundantSourceReads(CTX)).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("caps the lookback so one call cannot scan the whole event table", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { generateRedundantSourceReads } = await import("../source-topology");
    await generateRedundantSourceReads({ ...CTX, lookbackDays: 3650 });
    expect(mockQuery.mock.calls[0][1][0]).toBe("30");
  });
});

describe("the fingerprint", () => {
  it("is stable, short, and identical for identical requests", async () => {
    const { fingerprintPath } = await import(
      "@/lib/assistant/connectors/rest-connector"
    );
    const a = fingerprintPath("/crm/v3/objects/contacts/42");
    expect(a).toBe(fingerprintPath("/crm/v3/objects/contacts/42"));
    expect(a).toHaveLength(16);
  });

  it("does not carry the customer's text through into analytics", async () => {
    /* A search path contains whatever the person typed. Storing it is
       storing the client's data in our table; that is the reason this
       is a hash and not the path. */
    const { fingerprintPath } = await import(
      "@/lib/assistant/connectors/rest-connector"
    );
    const fp = fingerprintPath("/contacts?q=Ackerman%20Motor%20Group&limit=10");
    expect(fp).not.toMatch(/Ackerman/i);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates two different asks of the same system", async () => {
    const { fingerprintPath } = await import(
      "@/lib/assistant/connectors/rest-connector"
    );
    expect(fingerprintPath("/contacts/1")).not.toBe(fingerprintPath("/contacts/2"));
  });
});
