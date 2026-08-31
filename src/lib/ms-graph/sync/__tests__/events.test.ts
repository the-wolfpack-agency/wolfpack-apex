/**
 * The calendar worker, which runs first and had never run at all.
 *
 * It is the one entity switched on, so it meets a real Graph tenant before any
 * of the others. Nothing about it was tested, and a first delta sync has
 * failure modes a steady-state one does not: no cursor yet, a tenant that
 * returns removals immediately, an event with no start time.
 */
const mockDelta = jest.fn();
const mockWrite = jest.fn();
const mockSafe = jest.fn();

jest.mock("../../client", () => ({
  listCalendarEventsDelta: (...a: unknown[]) => mockDelta(...a),
  /* common.ts imports this from the same module, so a fake that omits it
     fails inside the error path rather than in the code under test. */
  describeGraphError: (err: unknown) => ({
    code: (err as { status?: number })?.status === 403 ? "scope_missing" : "network_error",
    status: (err as { status?: number })?.status ?? 0,
    message: (err as Error)?.message ?? "unknown",
  }),
}));
jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWrite(...a),
  safeQuery: (...a: unknown[]) => mockSafe(...a),
  query: (...a: unknown[]) => mockSafe(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { syncUser } from "../events";

const event = (over: Record<string, unknown> = {}) => ({
  id: "evt-1",
  subject: "Porsche weekly",
  bodyPreview: "agenda",
  start: { dateTime: "2026-08-31T10:00:00" },
  end: { dateTime: "2026-08-31T11:00:00" },
  organizer: { emailAddress: { address: "nick@example.com" } },
  attendees: [{ emailAddress: { name: "Dana", address: "dana@example.com" }, type: "required" }],
  isOnlineMeeting: true,
  lastModifiedDateTime: "2026-08-31T09:00:00Z",
  ...over,
});

beforeEach(() => {
  mockDelta.mockReset();
  mockWrite.mockReset().mockResolvedValue({ rows: [{ inserted: true }] });
  mockSafe.mockReset().mockResolvedValue({ rows: [] });
});

describe("the first sync a tenant ever runs", () => {
  /* No cursor exists yet, so the worker must ask for a full delta rather than
     passing undefined into a URL and asking Graph for nothing. */
  it("asks for a full delta when there is no cursor", async () => {
    mockDelta.mockResolvedValue({ items: [event()], nextDeltaLink: "https://delta/next" });
    const res = await syncUser("nick@example.com");
    expect(mockDelta).toHaveBeenCalledWith("nick@example.com", undefined);
    expect(res.created).toBe(1);
    expect(res.error).toBeUndefined();
  });

  /* Without this the next run re-reads the whole calendar every night, which
     works and quietly costs a full sync forever. */
  it("saves the cursor so the next run is incremental", async () => {
    mockDelta.mockResolvedValue({ items: [], nextDeltaLink: "https://delta/next" });
    await syncUser("nick@example.com");
    const wrote = mockWrite.mock.calls.map((c) => String(c[0])).join(" ");
    expect(wrote).toMatch(/instinct_ms_sync_cursors|delta_link/i);
  });

  it("counts an update separately from a creation", async () => {
    mockWrite.mockResolvedValue({ rows: [{ inserted: false }] });
    mockDelta.mockResolvedValue({ items: [event()], nextDeltaLink: null });
    const res = await syncUser("nick@example.com");
    expect(res).toMatchObject({ created: 0, updated: 1 });
  });
});

describe("what a real calendar contains", () => {
  /* An all-day event has a date and no dateTime, and a cancelled one arrives
     with no start at all. Either throwing would fail the whole sync for one
     odd row. */
  it("survives an event with no start time", async () => {
    mockDelta.mockResolvedValue({ items: [event({ start: undefined, end: undefined })], nextDeltaLink: null });
    const res = await syncUser("nick@example.com");
    expect(res.error).toBeUndefined();
    expect(res.created).toBe(1);
  });

  it("handles an event with no attendees", async () => {
    mockDelta.mockResolvedValue({ items: [event({ attendees: undefined })], nextDeltaLink: null });
    expect((await syncUser("nick@example.com")).error).toBeUndefined();
  });

  /* A removal in the first delta is normal: Graph reports what changed since
     the beginning of the window, deletions included. */
  it("counts a removal without treating it as a write", async () => {
    mockSafe.mockResolvedValue({ rows: [{ id: "row-1" }] });
    mockDelta.mockResolvedValue({
      items: [{ id: "evt-gone", "@removed": { reason: "deleted" } }],
      nextDeltaLink: null,
    });
    const res = await syncUser("nick@example.com");
    expect(res.deleted).toBe(1);
    expect(res.created).toBe(0);
  });
});

describe("when Graph says no", () => {
  /* THE FAILURE THAT MUST NOT THROW. Calendars.Read may not be granted, and
     the dispatcher relies on a returned error rather than an exception to
     keep the other workers running. */
  it("reports a refusal rather than throwing", async () => {
    mockDelta.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    const res = await syncUser("nick@example.com");
    expect(res.entityType).toBe("events");
    expect(res.error).toBeTruthy();
  });

  it("reports a network failure the same way", async () => {
    mockDelta.mockRejectedValue(new Error("socket hang up"));
    const res = await syncUser("nick@example.com");
    expect(res.error).toBeTruthy();
    expect(res.created).toBe(0);
  });
});
