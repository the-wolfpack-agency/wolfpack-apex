/**
 * MS Graph sync — contacts worker.
 */
 

export {};

const mockListContactsDelta = jest.fn();
const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ms-graph/client", () => ({
  listContactsDelta: (...a: any[]) => mockListContactsDelta(...a),
  GraphClientError: class extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
      this.name = "GraphClientError";
    }
  },
  describeGraphError: (err: any) =>
    err && err.name === "GraphClientError"
      ? { code: err.code, status: err.status, message: err.message }
      : { code: "unknown", status: 0, message: (err as Error)?.message },
}));

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  query: (...a: any[]) => mockQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [] });
  mockQuery.mockResolvedValue({ rows: [{ id: "r" }] });
  mockWriteQuery.mockResolvedValue({ rows: [{ inserted: true }] });
});

describe("contacts sync worker", () => {
  it("upserts display_name + email_addresses + company_name", async () => {
    mockListContactsDelta.mockResolvedValueOnce({
      items: [
        {
          id: "ct-1",
          displayName: "Jane Doe",
          emailAddresses: [{ address: "jane@x" }, { address: "j2@x" }],
          companyName: "Acme",
          jobTitle: "VP",
        },
      ],
      nextDeltaLink: "https://x/ct-delta",
    });
    const { syncUser } = await import("@/lib/ms-graph/sync/contacts");
    const res = await syncUser("u-1");
    expect(res.created).toBe(1);
    const upsert = mockWriteQuery.mock.calls.find(([sql]) =>
      /INSERT INTO instinct_ms_contacts/.test(sql),
    );
    expect(upsert[1][2]).toBe("Jane Doe"); // display_name
    expect(JSON.parse(upsert[1][5])).toEqual(["jane@x", "j2@x"]);
    expect(upsert[1][6]).toBe("Acme");
  });

  it("delete path on @removed contact", async () => {
    mockListContactsDelta.mockResolvedValueOnce({
      items: [{ id: "ct-gone", "@removed": { reason: "deleted" } }],
      nextDeltaLink: "https://x/ct-delta",
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "r" }] });
    mockWriteQuery
      .mockResolvedValueOnce({ rows: [{ id: "log" }] })
      .mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] });

    const { syncUser } = await import("@/lib/ms-graph/sync/contacts");
    const res = await syncUser("u-1");
    expect(res.deleted).toBe(1);
  });
});
