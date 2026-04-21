/**
 * MS Graph sync — messages (Outlook mail) worker.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockListMailDelta = jest.fn();
const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ms-graph/client", () => ({
  listMailDelta: (...a: any[]) => mockListMailDelta(...a),
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

describe("messages sync worker", () => {
  it("upserts message with from/to/hasAttachments, created++", async () => {
    mockListMailDelta.mockResolvedValueOnce({
      items: [
        {
          id: "mail-1",
          subject: "Hello",
          bodyPreview: "preview",
          from: { emailAddress: { address: "sender@x" } },
          toRecipients: [
            { emailAddress: { address: "a@x" } },
            { emailAddress: { address: "b@x" } },
          ],
          hasAttachments: true,
          receivedDateTime: "2026-04-19T10:00:00Z",
        },
      ],
      nextDeltaLink: "https://x/mail-delta",
    });
    const { syncUser } = await import("@/lib/ms-graph/sync/messages");
    const res = await syncUser("u-1");
    expect(res.created).toBe(1);
    const upsert = mockWriteQuery.mock.calls.find(([sql]) =>
      /INSERT INTO instinct_ms_messages/.test(sql),
    );
    expect(upsert[1][4]).toBe("sender@x"); // from_email
    expect(JSON.parse(upsert[1][5])).toEqual(["a@x", "b@x"]); // to_emails
    expect(upsert[1][6]).toBe(true); // has_attachments
  });

  it("empty delta still saves deltaLink", async () => {
    mockListMailDelta.mockResolvedValueOnce({
      items: [],
      nextDeltaLink: "https://x/delta-init",
    });
    const { syncUser } = await import("@/lib/ms-graph/sync/messages");
    await syncUser("u-1");
    const cursorCall = mockWriteQuery.mock.calls.find(([sql]) =>
      /instinct_ms_sync_cursors/.test(sql),
    );
    expect(cursorCall[1][2]).toBe("https://x/delta-init");
  });

  it("scope_missing path short-circuits cleanly", async () => {
    const err: any = new Error("forbidden");
    err.name = "GraphClientError";
    err.code = "scope_missing";
    err.status = 403;
    mockListMailDelta.mockRejectedValueOnce(err);
    const { syncUser } = await import("@/lib/ms-graph/sync/messages");
    const res = await syncUser("u-1");
    expect(res.error).toBe("scope_missing");
    expect(
      mockTrack.mock.calls.some(([name]) => name === "ms_sync.scope_missing"),
    ).toBe(true);
  });
});
