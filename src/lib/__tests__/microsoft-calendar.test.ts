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

// ---------------------------------------------------------------------------
// searchCalendarEvents — keyword-aware /me/calendarView wrapper used by the
// assistant context resolver.
// ---------------------------------------------------------------------------

describe("searchCalendarEvents", () => {
  const baseEvent = (over: Record<string, unknown> = {}) => ({
    id: "ev-1",
    subject: "Porsche dealer sync",
    start: { dateTime: "2026-03-12T15:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-03-12T16:00:00", timeZone: "UTC" },
    bodyPreview: "Walked through dealer pipeline and Q2 incentives",
    body: { contentType: "text", content: "" },
    organizer: { emailAddress: { name: "Nick", address: "nick@example.com" } },
    attendees: [
      { emailAddress: { name: "Aidan", address: "aidan@example.com" } },
      { emailAddress: { name: "Aidan", address: "aidan@example.com" } },
      { emailAddress: { name: "Hoxsie", address: "hox@example.com" } },
    ],
    webLink: "https://outlook.office.com/calendar/item/ev-1",
    ...over,
  });

  it("hits /me/calendarView with start/end window + $select and returns ranked CalendarEventHits", async () => {
    fetchMockCal.mockResolvedValueOnce(okJsonCal({
      value: [
        baseEvent(),
        baseEvent({
          id: "ev-2",
          subject: "Wolfpack standup",
          bodyPreview: "Q2 OKRs",
        }),
      ],
    }));

    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("tok", { query: "porsche" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    /* Only the porsche event should match (the standup has score 0). */
    expect(r.value.hits).toHaveLength(1);
    expect(r.value.hits[0].id).toBe("ev-1");
    expect(r.value.hits[0].source_kind).toBe("calendar");
    expect(r.value.hits[0].url).toBe("https://outlook.office.com/calendar/item/ev-1");
    expect(r.value.hits[0].snippet).toContain("dealer pipeline");
    expect(r.value.hits[0].attendees).toEqual(["Aidan", "Hoxsie"]); // deduped

    const url = fetchMockCal.mock.calls[0][0] as string;
    expect(url).toContain("me/calendarView");
    expect(url).toContain("startDateTime=");
    expect(url).toContain("endDateTime=");
    expect(url).toContain("$select=");
  });

  it("respects topN cap", async () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      baseEvent({ id: `ev-${i}`, subject: "Porsche review" }),
    );
    fetchMockCal.mockResolvedValueOnce(okJsonCal({ value: events }));

    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("tok", { query: "porsche", topN: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hits).toHaveLength(3);
  });

  it("uses caller-supplied date range over the default window", async () => {
    fetchMockCal.mockResolvedValueOnce(okJsonCal({ value: [] }));

    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("tok", {
      query: "porsche",
      startDateTime: "2026-03-01T00:00:00Z",
      endDateTime: "2026-03-31T23:59:59Z",
    });
    expect(r.ok).toBe(true);
    const url = fetchMockCal.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("2026-03-01"));
    expect(url).toContain(encodeURIComponent("2026-03-31"));
  });

  it("returns scope_missing on 403 and never throws", async () => {
    fetchMockCal.mockResolvedValueOnce(
      errResCal(403, { error: { code: "ErrorAccessDenied", message: "scope missing" } }),
    );
    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("tok", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("scope_missing");
    expect(r.scope).toBe("Calendars.Read");
    expect(r.status).toBe(403);
  });

  it("returns graph_error on unexpected 500", async () => {
    fetchMockCal.mockResolvedValueOnce(errResCal(500, "boom"));
    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("tok", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("graph_error");
    expect(r.status).toBe(500);
  });

  it("returns invalid_input for empty query without calling Graph", async () => {
    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("tok", { query: "  " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
    expect(fetchMockCal).not.toHaveBeenCalled();
  });

  it("returns not_connected when token is empty", async () => {
    const { searchCalendarEvents } = await import("@/lib/integrations/microsoft-calendar");
    const r = await searchCalendarEvents("", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_connected");
  });

  it("trackCalendarLookupFailure emits assistant.calendar_lookup_failed", async () => {
    const { trackCalendarLookupFailure } = await import("@/lib/integrations/microsoft-calendar");
    trackCalendarLookupFailure("u", "cto", { ok: false, code: "scope_missing", status: 403 });
    expect(mockTrackCal).toHaveBeenCalledWith(
      "assistant.calendar_lookup_failed",
      "u",
      "cto",
      expect.objectContaining({ status: 403, scope_missing: true, code: "scope_missing" }),
    );
  });
});
