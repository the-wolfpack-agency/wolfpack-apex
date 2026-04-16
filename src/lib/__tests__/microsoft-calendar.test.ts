/**
 * Microsoft Calendar integration tests.
 *
 * Covers: create/update/delete round-trip (Graph + cache + audit +
 * analytics), attendees JSON, list read path, 403 → scope_missing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackCal = jest.fn();
const mockQueryCal = jest.fn();
const mockGetValidTokenCal = jest.fn();
const mockRecordAuditCal = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackCal(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryCal(...args),
  safeQuery: jest.fn(),
  pool: { query: jest.fn() },
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenCal(...args),
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAuditCal(...args),
}));

const realFetchCal = global.fetch;
const fetchMockCal = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMockCal;
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  (global as any).fetch = realFetchCal;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockCal.mockReset();
  mockGetValidTokenCal.mockResolvedValue({ accessToken: "tok", userEmail: "u@e.com" });
  mockQueryCal.mockResolvedValue({ rows: [] });
  mockRecordAuditCal.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});

function okJsonCal(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}
function createdCal(body: unknown) {
  return {
    ok: true,
    status: 201,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as any;
}
function noContentCal() {
  return {
    ok: true,
    status: 204,
    headers: new Headers(),
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(""),
  } as any;
}
function errResCal(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as any;
}

// ---------------------------------------------------------------------------
// createEvent
// ---------------------------------------------------------------------------

describe("createEvent", () => {
  it("posts to /me/events, writes cache row, emits audit + analytics", async () => {
    fetchMockCal.mockResolvedValueOnce(createdCal({ id: "ev-1", webLink: "https://outlook/ev-1" }));
    const { createEvent } = await import("@/lib/integrations/microsoft-calendar");

    const start = "2026-04-20T14:00:00.000Z";
    const end = "2026-04-20T15:00:00.000Z";
    const result = await createEvent("user-1", {
      subject: "Meet",
      start,
      end,
      attendees: ["a@b.com", "c@d.com"],
      location: "Zoom",
      bodyText: "agenda",
    }, "cto");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.id).toBe("ev-1");
    expect(result.value.webLink).toBe("https://outlook/ev-1");

    const [url, init] = fetchMockCal.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/events");
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe("Meet");
    expect(body.attendees).toHaveLength(2);
    expect(body.attendees[0]).toEqual({ emailAddress: { address: "a@b.com" }, type: "required" });
    expect(body.start).toEqual({ dateTime: start, timeZone: "UTC" });

    expect(mockQueryCal).toHaveBeenCalledTimes(1);
    const args = mockQueryCal.mock.calls[0][1];
    expect(args[0]).toBe("user-1");
    expect(args[1]).toBe("ev-1");
    expect(args[2]).toBe("created");
    expect(JSON.parse(args[6])).toEqual(["a@b.com", "c@d.com"]);

    expect(mockRecordAuditCal).toHaveBeenCalledTimes(1);
    expect(mockRecordAuditCal.mock.calls[0][0].action).toBe("calendar.event.created");

    expect(mockTrackCal).toHaveBeenCalledWith(
      "system.ms_calendar_event_created",
      "user-1",
      "cto",
      expect.objectContaining({ event_id: "ev-1", attendee_count: 2 }),
    );
  });

  it("rejects when end <= start", async () => {
    const { createEvent } = await import("@/lib/integrations/microsoft-calendar");
    const t = "2026-04-20T14:00:00.000Z";
    const result = await createEvent("u", { subject: "x", start: t, end: t });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
    expect(fetchMockCal).not.toHaveBeenCalled();
  });

  it("returns scope_missing on 403", async () => {
    fetchMockCal.mockResolvedValueOnce(errResCal(403, { error: { code: "ErrorAccessDenied", message: "no scope" } }));
    const { createEvent } = await import("@/lib/integrations/microsoft-calendar");
    const result = await createEvent("u", {
      subject: "s", start: "2026-05-01T10:00:00Z", end: "2026-05-01T11:00:00Z",
    });
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("scope_missing");
    expect(result.scope).toBe("Calendars.ReadWrite");
    expect(mockQueryCal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateEvent
// ---------------------------------------------------------------------------

describe("updateEvent", () => {
  it("patches fields and writes updated cache row + audit + analytics", async () => {
    fetchMockCal.mockResolvedValueOnce(okJsonCal({ id: "ev-2", subject: "patched" }));
    const { updateEvent } = await import("@/lib/integrations/microsoft-calendar");
    const result = await updateEvent("u", "ev-2", { subject: "patched", location: "Room 3" });
    expect(result.ok).toBe(true);

    const [url, init] = fetchMockCal.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/events/ev-2");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe("patched");
    expect(body.location).toEqual({ displayName: "Room 3" });

    expect(mockQueryCal).toHaveBeenCalled();
    expect(mockQueryCal.mock.calls[0][1][2]).toBe("updated");
    expect(mockRecordAuditCal.mock.calls[0][0].action).toBe("calendar.event.updated");
    expect(mockTrackCal).toHaveBeenCalledWith(
      "system.ms_calendar_event_updated",
      "u",
      expect.any(String),
      expect.objectContaining({ event_id: "ev-2" }),
    );
  });

  it("rejects empty patch", async () => {
    const { updateEvent } = await import("@/lib/integrations/microsoft-calendar");
    const result = await updateEvent("u", "ev", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// deleteEvent
// ---------------------------------------------------------------------------

describe("deleteEvent", () => {
  it("issues DELETE + writes cache action=deleted + audit + analytics", async () => {
    fetchMockCal.mockResolvedValueOnce(noContentCal());
    const { deleteEvent } = await import("@/lib/integrations/microsoft-calendar");
    const result = await deleteEvent("u", "ev-3");
    expect(result.ok).toBe(true);
    expect(fetchMockCal.mock.calls[0][1].method).toBe("DELETE");
    expect(mockQueryCal.mock.calls[0][1][2]).toBe("deleted");
    expect(mockRecordAuditCal.mock.calls[0][0].action).toBe("calendar.event.deleted");
    expect(mockTrackCal).toHaveBeenCalledWith(
      "system.ms_calendar_event_deleted",
      "u",
      expect.any(String),
      expect.objectContaining({ event_id: "ev-3" }),
    );
  });

  it("returns not_found on 404", async () => {
    fetchMockCal.mockResolvedValueOnce(errResCal(404, { error: { code: "NotFound" } }));
    const { deleteEvent } = await import("@/lib/integrations/microsoft-calendar");
    const result = await deleteEvent("u", "missing");
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe("listEvents", () => {
  it("fetches from /me/calendarview with $top + maps attendees", async () => {
    fetchMockCal.mockResolvedValueOnce(okJsonCal({
      value: [
        {
          id: "ev-1",
          subject: "Meet",
          start: { dateTime: "2026-05-01T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-05-01T11:00:00", timeZone: "UTC" },
          location: { displayName: "Zoom" },
          attendees: [{ emailAddress: { name: "Alice", address: "a@b.com" } }],
          isOnlineMeeting: true,
        },
      ],
    }));
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");
    const events = await listEvents("u", { from: "2026-05-01T00:00:00Z", to: "2026-05-02T00:00:00Z", limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].attendees).toEqual(["Alice"]);
    expect(events[0].isOnlineMeeting).toBe(true);
    const url = fetchMockCal.mock.calls[0][0] as string;
    expect(url).toContain("calendarview");
    expect(url).toContain("$top=10");
  });
});
