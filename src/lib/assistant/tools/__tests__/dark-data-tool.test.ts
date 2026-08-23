/**
 * The assistant path to "what's in there that nobody uses?"
 *
 * The scan's safety is proved next to the scanner. What matters here is
 * that the question reaches the tool, that a missing database is an
 * answer rather than an error, and that a client's schema does not
 * accumulate in our analytics table.
 */

export {};

const mockScan = jest.fn();
jest.mock("@/lib/sources/legacy-postgres", () => ({
  scanLegacyDatabase: (...a: any[]) => mockScan(...a),
  legacyDatabaseName: () => "the DMS",
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrack(...a) }));

const CTX: any = { userId: "u1", userRole: "admin" };

beforeEach(() => jest.clearAllMocks());

async function tool() {
  return (await import("../dark-data-tool")).darkDataTool;
}

describe("the question reaches it", () => {
  it.each([
    "what's in the legacy database that nobody uses",
    "what is in the db that no one reads",
    "show me the dark data",
    "unused columns",
    "what data are we not using",
    "what else is there that we have never asked for",
  ])("matches %p", async (phrase) => {
    expect((await tool()).matchIntent!(phrase)).not.toBeNull();
  });

  it("does not fire on an ordinary data question", async () => {
    const t = await tool();
    expect(t.matchIntent!("how many customers do we have")).toBeNull();
    expect(t.matchIntent!("show me the database schema")).toBeNull();
  });
});

describe("what it answers", () => {
  it("explains rather than failing when no database is connected", async () => {
    mockScan.mockResolvedValue(null);
    const t = await tool();
    const res: any = await t.handler({}, CTX);
    expect(res.ok).toBe(true);
    expect(res.answer).toContain("No legacy database is connected");
  });

  it("names the columns nothing reads", async () => {
    mockScan.mockResolvedValue({
      tables: [],
      columns: [
        { table: "customers", column: "loyalty_tier", dataType: "text", nullFraction: 0.1 },
        { table: "customers", column: "full_name", dataType: "text", nullFraction: 0 },
      ],
      shapes: [{ shape: "SELECT full_name FROM customers WHERE id = $1", calls: 100, totalMs: 50 }],
      statementStatsAvailable: true,
      statementTracking: "all",
    });
    const t = await tool();
    const res: any = await t.handler({}, CTX);
    expect(res.data.darkColumns).toBe(1);
    expect(res.answer).toContain("loyalty_tier");
  });

  it("surfaces an unreachable database as a clear failure, not a clean report", async () => {
    /* An empty report from a database we could not read says "nothing
       to find", which is the one wrong answer. */
    mockScan.mockRejectedValue(new Error("ECONNREFUSED"));
    const t = await tool();
    const res: any = await t.handler({}, CTX);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("the DMS");
  });
});

describe("what reaches analytics", () => {
  it("records counts and not the client's column names", async () => {
    mockScan.mockResolvedValue({
      tables: [],
      columns: [
        { table: "dealer_accounts", column: "acquisition_channel", dataType: "text", nullFraction: 0.2 },
      ],
      shapes: [{ shape: "SELECT id FROM dealer_accounts", calls: 10, totalMs: 5 }],
      statementStatsAvailable: true,
      statementTracking: "all",
    });
    const t = await tool();
    await t.handler({}, CTX);

    const [event, , , meta] = mockTrack.mock.calls[0];
    expect(event).toBe("assistant.dark_data_scanned");
    expect(meta).toMatchObject({ dark_columns: 1, statements_examined: 1 });
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("acquisition_channel");
    expect(serialized).not.toContain("dealer_accounts");
  });
});
