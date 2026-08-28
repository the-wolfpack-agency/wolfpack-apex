/**
 * "We have never looked" is not "you have none".
 *
 * WHAT THIS WOULD HAVE CAUGHT. Every Microsoft mirror table in production is
 * empty and instinct_ms_sync_cursors has never held a row, because nothing
 * schedules the sync. The task tool read the empty table and told everybody
 * "You have no open tasks. Nice." — cheerful, confident, and false for anyone
 * with a To-Do list, with no way for the reader to tell.
 *
 * Nothing failed. There was nothing to fail: the read returned [] exactly as
 * designed, and [] is a perfectly good answer to a question nobody had checked
 * was askable.
 */
import { getSyncState, unsyncedNotice } from "@/lib/ms-graph/sync-state";

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

beforeEach(() => jest.clearAllMocks());

describe("reading whether a sync ever ran", () => {
  it("reports never when there is no cursor row", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getSyncState("u1", "tasks")).toEqual({
      everSynced: false,
      lastSyncedAt: null,
    });
  });

  it("reports synced, with when, once a cursor exists", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ last_synced_at: "2026-08-28T10:00:00.000Z" }],
    });
    const s = await getSyncState("u1", "tasks");
    expect(s.everSynced).toBe(true);
    expect(s.lastSyncedAt?.toISOString()).toBe("2026-08-28T10:00:00.000Z");
  });

  /* A cursor with no timestamp still proves a sync completed. Treating the
     missing date as "never synced" would re-introduce the bug for any row
     written before the column was populated. */
  it("counts a cursor with no timestamp as synced", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ last_synced_at: null }] });
    const s = await getSyncState("u1", "tasks");
    expect(s.everSynced).toBe(true);
    expect(s.lastSyncedAt).toBeNull();
  });

  /* THE DIRECTION A FAILURE FALLS MATTERS. If we cannot read the cursor we do
     not know whether a sync ran, and the only thing a caller does with this is
     choose between "you have none" and "we have not looked". Claiming a sync
     we cannot evidence is exactly how the original bug reads. */
  it("falls to never when the read itself fails", async () => {
    mockSafeQuery.mockRejectedValue(new Error("db down"));
    expect(await getSyncState("u1", "tasks")).toEqual({
      everSynced: false,
      lastSyncedAt: null,
    });
  });

  it("does not query at all without a user", async () => {
    expect(await getSyncState("", "tasks")).toEqual({
      everSynced: false,
      lastSyncedAt: null,
    });
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  /* The cursor table is keyed by the sync worker's own entity names. A second
     literal union that said "mail" where the worker says "messages" would
     query a row that can never exist and report every mailbox as never-synced
     forever, which is a quieter version of the same bug. */
  it("queries the entity name the sync worker writes", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await getSyncState("u1", "messages");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["u1", "messages"]);
  });
});

describe("what an empty list is allowed to claim", () => {
  it("hands back a notice when nothing has ever been synced", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const notice = await unsyncedNotice("u1", "tasks", "tasks");
    expect(notice).toContain("not been synced yet");
    /* Names the next step. A correct sentence somebody cannot act on is the
       failure the roster lookup had before it started naming its roles. */
    expect(notice).toMatch(/Settings/);
  });

  /* THE OTHER HALF, AND IT MATTERS AS MUCH. Once a sync has run, an empty list
     genuinely means empty, and a notice there would be its own lie: telling
     somebody with a clear To-Do list that we cannot see it. */
  it("stays silent once a sync has run, so a real zero reads as zero", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ last_synced_at: "2026-08-28T10:00:00.000Z" }],
    });
    expect(await unsyncedNotice("u1", "tasks", "tasks")).toBeNull();
  });

  it("uses the reader's word for the thing, not the table's", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const notice = await unsyncedNotice("u1", "messages", "emails");
    expect(notice).toContain("emails");
    expect(notice).not.toContain("messages");
  });
});
