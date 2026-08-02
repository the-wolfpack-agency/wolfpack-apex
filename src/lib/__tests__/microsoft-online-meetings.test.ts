/**
 * Microsoft Online Meetings tests.
 *
 * Covers createMeeting / updateMeeting / getMeeting / linkToEvent /
 * attachTeamsMeetingToEventInput, input validation, 403 scope_missing,
 * 429 retry, audit + analytics emission, cache upsert.
 */
 

export {};

const mockTrackOM = jest.fn();
const mockQueryOM = jest.fn();
const mockSafeQueryOM = jest.fn();
const mockGetValidTokenOM = jest.fn();
const mockRecordAuditOM = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackOM(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryOM(...args),
  safeQuery: (...args: any[]) => mockSafeQueryOM(...args),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenOM(...args),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAuditOM(...args),
}));

const realFetchOM = global.fetch;
const fetchMockOM = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMockOM;
  process.env.DATABASE_URL = "postgres://shadow"; // enable cache path
});
afterAll(() => {
  (global as any).fetch = realFetchOM;
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockOM.mockReset();
  mockGetValidTokenOM.mockResolvedValue({
    accessToken: "tok-abc",
    userEmail: "u@x",
  });
  mockRecordAuditOM.mockResolvedValue({ id: "a-1" });
  mockQueryOM.mockResolvedValue({ rows: [] });
});

function okResp(data: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResp(status: number, body: any = null, headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("validateCreate (via __internal)", () => {
  it("rejects missing subject / dates / end <= start", async () => {
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    expect(
      mod.__internal.validateCreate({
        subject: "",
        startAt: "2026-04-01T10:00Z",
        endAt: "2026-04-01T11:00Z",
      } as any),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      mod.__internal.validateCreate({
        subject: "x",
        startAt: "",
        endAt: "",
      } as any),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      mod.__internal.validateCreate({
        subject: "x",
        startAt: "2026-04-01T10:00Z",
        endAt: "2026-04-01T10:00Z",
      } as any),
    ).toMatchObject({ message: "end_must_be_after_start" });
    expect(
      mod.__internal.validateCreate({
        subject: "x",
        startAt: "not-a-date",
        endAt: "2026-04-01T11:00Z",
      } as any),
    ).toMatchObject({ message: "invalid_date" });
  });

  it("passes a valid input", async () => {
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    expect(
      mod.__internal.validateCreate({
        subject: "Kickoff",
        startAt: "2026-04-01T10:00:00Z",
        endAt: "2026-04-01T11:00:00Z",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createMeeting — happy path, 403, 429, not_connected
// ---------------------------------------------------------------------------

describe("createMeeting", () => {
  it("returns not_connected when token missing", async () => {
    mockGetValidTokenOM.mockResolvedValueOnce(null);
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.createMeeting("u-1", {
      subject: "s",
      startAt: "2026-04-01T10:00:00Z",
      endAt: "2026-04-01T11:00:00Z",
    });
    expect(res).toMatchObject({ ok: false, code: "not_connected" });
    expect(mockTrackOM).toHaveBeenCalledWith(
      "system.ms_online_meeting_failed",
      "u-1",
      "system",
      expect.objectContaining({ op: "create", reason: "not_connected" }),
    );
  });

  it("creates a meeting and emits created event + audit", async () => {
    fetchMockOM.mockResolvedValueOnce(
      okResp({
        id: "meet-1",
        joinWebUrl: "https://teams.microsoft.com/l/meetup-join/xyz",
        audioConferencing: { conferenceId: "123 456", tollNumber: "+1-555-0100" },
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.createMeeting("u-1", {
      subject: "Kickoff",
      startAt: "2026-04-01T10:00:00Z",
      endAt: "2026-04-01T11:00:00Z",
      participants: ["alice@x.com", "bob@x.com"],
    });
    expect(res).toMatchObject({
      ok: true,
      value: {
        id: "meet-1",
        joinWebUrl: expect.stringContaining("meetup-join"),
        conferenceId: "123 456",
      },
    });
    expect(mockQueryOM).toHaveBeenCalled(); // cache upsert
    expect(mockRecordAuditOM).toHaveBeenCalledWith(
      expect.objectContaining({ action: "online_meeting.created" }),
    );
    expect(mockTrackOM).toHaveBeenCalledWith(
      "system.ms_online_meeting_created",
      "u-1",
      "system",
      expect.objectContaining({ meeting_id: "meet-1", participant_count: 2 }),
    );
  });

  it("maps Graph 403 AccessDenied to scope_missing", async () => {
    fetchMockOM.mockResolvedValueOnce(
      errResp(403, {
        error: { code: "AccessDenied", message: "Caller needs scope" },
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.createMeeting("u-1", {
      subject: "s",
      startAt: "2026-04-01T10:00:00Z",
      endAt: "2026-04-01T11:00:00Z",
    });
    expect(res).toMatchObject({
      ok: false,
      code: "scope_missing",
      scope: "OnlineMeetings.ReadWrite.All",
    });
  });

  it("retries once on 429 and succeeds", async () => {
    fetchMockOM
      .mockResolvedValueOnce(errResp(429, null, { "retry-after": "0" }))
      .mockResolvedValueOnce(
        okResp({
          id: "m2",
          joinWebUrl: null,
          audioConferencing: null,
        }),
      );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.createMeeting("u-1", {
      subject: "s",
      startAt: "2026-04-01T10:00:00Z",
      endAt: "2026-04-01T11:00:00Z",
    });
    expect(res.ok).toBe(true);
    expect(fetchMockOM).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// updateMeeting
// ---------------------------------------------------------------------------

describe("updateMeeting", () => {
  it("rejects empty patch", async () => {
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.updateMeeting("u-1", "m-1", {});
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("patches subject and emits updated event", async () => {
    fetchMockOM.mockResolvedValueOnce(
      okResp({
        id: "m-1",
        subject: "Renamed",
        joinWebUrl: null,
        audioConferencing: null,
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.updateMeeting("u-1", "m-1", { subject: "Renamed" });
    expect(res).toMatchObject({ ok: true, value: { id: "m-1" } });
    expect(mockTrackOM).toHaveBeenCalledWith(
      "system.ms_online_meeting_updated",
      "u-1",
      "system",
      expect.objectContaining({ meeting_id: "m-1", fields_changed: "subject" }),
    );
    expect(mockRecordAuditOM).toHaveBeenCalledWith(
      expect.objectContaining({ action: "online_meeting.updated" }),
    );
  });

  it("returns not_found on 404", async () => {
    fetchMockOM.mockResolvedValueOnce(errResp(404));
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.updateMeeting("u-1", "m-1", { subject: "x" });
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// getMeeting read-through Graph → cache
// ---------------------------------------------------------------------------

describe("getMeeting", () => {
  it("prefers Graph data when available", async () => {
    fetchMockOM.mockResolvedValueOnce(
      okResp({
        id: "m-1",
        subject: "Kickoff",
        startDateTime: "2026-04-01T10:00:00Z",
        endDateTime: "2026-04-01T11:00:00Z",
        joinWebUrl: "https://teams/x",
        audioConferencing: { conferenceId: "1", tollNumber: "+1" },
        participants: { attendees: [{ upn: "a@x.com" }] },
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const meeting = await mod.getMeeting("u-1", "m-1");
    expect(meeting).toMatchObject({
      msMeetingId: "m-1",
      subject: "Kickoff",
      joinWebUrl: "https://teams/x",
      participants: ["a@x.com"],
    });
  });

  it("falls back to cache when Graph fails", async () => {
    fetchMockOM.mockResolvedValueOnce(errResp(500, { error: "bad" }));
    mockSafeQueryOM.mockResolvedValueOnce({
      rows: [
        {
          id: "local-1",
          user_id: "u-1",
          ms_meeting_id: "m-1",
          ms_event_id: null,
          subject: "Cached",
          start_at: new Date().toISOString(),
          end_at: new Date().toISOString(),
          join_web_url: null,
          conference_id: null,
          audio_conferencing_toll_number: null,
          participants: [],
          created_at: new Date().toISOString(),
          etag: null,
          synced_at: new Date().toISOString(),
        },
      ],
    });
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const meeting = await mod.getMeeting("u-1", "m-1");
    expect(meeting).toMatchObject({ subject: "Cached", msMeetingId: "m-1" });
  });
});

// ---------------------------------------------------------------------------
// linkToEvent + attachTeamsMeetingToEventInput
// ---------------------------------------------------------------------------

describe("linkToEvent", () => {
  it("updates ms_event_id and emits audit", async () => {
    mockQueryOM.mockResolvedValueOnce({ rows: [] });
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.linkToEvent("u-1", "m-1", "ev-1");
    expect(res.ok).toBe(true);
    expect(mockRecordAuditOM).toHaveBeenCalledWith(
      expect.objectContaining({ action: "online_meeting.linked" }),
    );
  });
});

describe("attachTeamsMeetingToEventInput", () => {
  it("creates a meeting and returns teamsForBusiness enrichment", async () => {
    fetchMockOM.mockResolvedValueOnce(
      okResp({
        id: "m-1",
        joinWebUrl: "https://teams/x",
        audioConferencing: { conferenceId: "1", tollNumber: "+1" },
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.attachTeamsMeetingToEventInput("u-1", {
      subject: "Kickoff",
      startAt: "2026-04-01T10:00:00Z",
      endAt: "2026-04-01T11:00:00Z",
      attendees: ["a@x.com"],
    });
    expect(res).toMatchObject({
      ok: true,
      value: {
        onlineMeetingProvider: "teamsForBusiness",
        onlineMeeting: {
          id: "m-1",
          joinUrl: "https://teams/x",
          conferenceId: "1",
        },
      },
    });
  });

  it("returns the underlying error on failure", async () => {
    fetchMockOM.mockResolvedValueOnce(
      errResp(403, {
        error: { code: "AccessDenied", message: "scope missing" },
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-online-meetings");
    const res = await mod.attachTeamsMeetingToEventInput("u-1", {
      subject: "Kickoff",
      startAt: "2026-04-01T10:00:00Z",
      endAt: "2026-04-01T11:00:00Z",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("scope_missing");
    }
  });
});
