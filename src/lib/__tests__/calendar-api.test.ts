/**
 * /api/calendar/events routes — GET/POST + [id]/PATCH + [id]/DELETE.
 */
 

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/integrations/microsoft-calendar", () => ({
  createEvent: (...args: unknown[]) => mockCreate(...args),
  updateEvent: (...args: unknown[]) => mockUpdate(...args),
  deleteEvent: (...args: unknown[]) => mockDelete(...args),
  listEvents: (...args: unknown[]) => mockList(...args),
}));

import { GET as eventsGET, POST as eventsPOST } from "@/app/api/calendar/events/route";
import { PATCH as eventPATCH, DELETE as eventDELETE } from "@/app/api/calendar/events/[id]/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string; method?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/calendar/events", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
});

// ---------------------------------------------------------------------------
// GET /api/calendar/events
// ---------------------------------------------------------------------------

describe("GET /api/calendar/events", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await eventsGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns events from listEvents with from/to/limit", async () => {
    mockList.mockResolvedValueOnce([{ id: "e1", subject: "Meet", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false }]);
    const res = await eventsGET(mkReq({ auth: "Bearer x", url: "http://test/api/calendar/events?from=2026-05-01&to=2026-05-02&limit=5" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith("u1", { from: "2026-05-01", to: "2026-05-02", limit: 5 });
  });
});

// ---------------------------------------------------------------------------
// POST /api/calendar/events
// ---------------------------------------------------------------------------

describe("POST /api/calendar/events", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await eventsPOST(mkReq({ body: {} }));
    expect(res.status).toBe(401);
  });

  it("201 on success with id + webLink", async () => {
    mockCreate.mockResolvedValueOnce({ ok: true, value: { id: "ev-1", webLink: "link" } });
    const res = await eventsPOST(mkReq({
      auth: "Bearer x",
      body: { subject: "s", start: "2026-05-01T10:00:00Z", end: "2026-05-01T11:00:00Z" },
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("ev-1");
    expect(data.webLink).toBe("link");
  });

  it("403 passes scope_missing through", async () => {
    mockCreate.mockResolvedValueOnce({ ok: false, code: "scope_missing", scope: "Calendars.ReadWrite" });
    const res = await eventsPOST(mkReq({
      auth: "Bearer x",
      body: { subject: "s", start: "2026-05-01T10:00:00Z", end: "2026-05-01T11:00:00Z" },
    }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("scope_missing");
  });

  it("400 on invalid_input", async () => {
    mockCreate.mockResolvedValueOnce({ ok: false, code: "invalid_input", message: "bad" });
    const res = await eventsPOST(mkReq({ auth: "Bearer x", body: {} }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/calendar/events/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/calendar/events/[id]", () => {
  it("passes only defined fields to updateEvent", async () => {
    mockUpdate.mockResolvedValueOnce({ ok: true, value: { id: "ev-2" } });
    const res = await eventPATCH(
      mkReq({ auth: "Bearer x", body: { subject: "new", location: "new room" }, method: "PATCH", url: "http://test/api/calendar/events/ev-2" }),
      { params: Promise.resolve({ id: "ev-2" }) },
    );
    expect(res.status).toBe(200);
    const patchArg = mockUpdate.mock.calls[0][2];
    expect(patchArg).toEqual({ subject: "new", location: "new room" });
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await eventPATCH(mkReq({ method: "PATCH", body: {} }), { params: Promise.resolve({ id: "ev" }) });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/calendar/events/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/calendar/events/[id]", () => {
  it("400 without ?confirm=true", async () => {
    const res = await eventDELETE(
      mkReq({ auth: "Bearer x", method: "DELETE", url: "http://test/api/calendar/events/ev-1" }),
      { params: Promise.resolve({ id: "ev-1" }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("confirmation_required");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("200 with ?confirm=true", async () => {
    mockDelete.mockResolvedValueOnce({ ok: true, value: undefined });
    const res = await eventDELETE(
      mkReq({ auth: "Bearer x", method: "DELETE", url: "http://test/api/calendar/events/ev-1?confirm=true" }),
      { params: Promise.resolve({ id: "ev-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("u1", "ev-1", "cto");
  });
});
