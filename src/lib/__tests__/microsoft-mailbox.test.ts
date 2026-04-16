/**
 * microsoft-mailbox.ts — mailbox settings, auto-reply, OOO refresh/persist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetValidToken = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok", userEmail: "u@x" });
  mockQuery.mockResolvedValue({ rows: [{ id: "uuid-x" }] });
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

function okResponse(data: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResponse(status: number): any {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve("err"),
  };
}

describe("getOwnMailboxSettings", () => {
  it("returns normalized settings on 200", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      timeZone: "Eastern Standard Time",
      dateFormat: "M/d/yyyy",
      language: { locale: "en-US" },
      automaticRepliesSetting: {
        status: "scheduled",
        externalAudience: "all",
        internalReplyMessage: "Back Monday",
        externalReplyMessage: "OOO until Monday",
        scheduledStartDateTime: { dateTime: "2026-04-20T00:00:00" },
        scheduledEndDateTime: { dateTime: "2026-04-25T00:00:00" },
      },
    }));
    const { getOwnMailboxSettings } = await import("@/lib/integrations/microsoft-mailbox");
    const s = await getOwnMailboxSettings("u");
    expect(s?.timeZone).toBe("Eastern Standard Time");
    expect(s?.autoReply?.status).toBe("scheduled");
    expect(s?.autoReply?.externalAudience).toBe("all");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_mailbox_settings_fetched",
      "u",
      "system",
      expect.objectContaining({ auto_reply_status: "scheduled" }),
    );
  });

  it("returns null on 403 and tracks failure", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403));
    const { getOwnMailboxSettings } = await import("@/lib/integrations/microsoft-mailbox");
    expect(await getOwnMailboxSettings("u")).toBeNull();
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_mailbox_settings_failed",
      "u",
      "system",
      expect.objectContaining({ reason: "scope_missing" }),
    );
  });

  it("returns null when token missing", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { getOwnMailboxSettings } = await import("@/lib/integrations/microsoft-mailbox");
    expect(await getOwnMailboxSettings("u")).toBeNull();
  });
});

describe("getOwnAutoReplySettings", () => {
  it("normalizes alwaysEnabled", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      status: "alwaysEnabled",
      externalAudience: "none",
      internalReplyMessage: "always out",
      externalReplyMessage: "",
    }));
    const { getOwnAutoReplySettings } = await import("@/lib/integrations/microsoft-mailbox");
    const a = await getOwnAutoReplySettings("u");
    expect(a?.status).toBe("alwaysEnabled");
    expect(a?.externalAudience).toBe("none");
  });

  it("returns null on 403", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403));
    const { getOwnAutoReplySettings } = await import("@/lib/integrations/microsoft-mailbox");
    expect(await getOwnAutoReplySettings("u")).toBeNull();
  });
});

describe("autoReplyToOOO", () => {
  it("disabled → is_enabled:false, scope:'none'", async () => {
    const { autoReplyToOOO } = await import("@/lib/integrations/microsoft-mailbox");
    const r = autoReplyToOOO({
      status: "disabled",
      externalAudience: "none",
      internalReplyMessage: null,
      externalReplyMessage: null,
      scheduledStartDateTime: null,
      scheduledEndDateTime: null,
      fetchedAt: new Date().toISOString(),
    });
    expect(r.isEnabled).toBe(false);
    expect(r.scope).toBe("none");
  });

  it("scheduled window containing now → is_enabled:true", async () => {
    const { autoReplyToOOO } = await import("@/lib/integrations/microsoft-mailbox");
    const now = Date.now();
    const r = autoReplyToOOO(
      {
        status: "scheduled",
        externalAudience: "all",
        internalReplyMessage: "i",
        externalReplyMessage: "e",
        scheduledStartDateTime: new Date(now - 1000).toISOString(),
        scheduledEndDateTime: new Date(now + 60_000).toISOString(),
        fetchedAt: new Date().toISOString(),
      },
      now,
    );
    expect(r.isEnabled).toBe(true);
    expect(r.scope).toBe("all");
  });

  it("scheduled outside window → is_enabled:false", async () => {
    const { autoReplyToOOO } = await import("@/lib/integrations/microsoft-mailbox");
    const now = Date.now();
    const r = autoReplyToOOO(
      {
        status: "scheduled",
        externalAudience: "contactsOnly",
        internalReplyMessage: null,
        externalReplyMessage: null,
        scheduledStartDateTime: new Date(now + 60_000).toISOString(),
        scheduledEndDateTime: new Date(now + 120_000).toISOString(),
        fetchedAt: new Date().toISOString(),
      },
      now,
    );
    expect(r.isEnabled).toBe(false);
    expect(r.scope).toBe("known");
  });
});

describe("refreshOwnOOOState", () => {
  it("persists enabled OOO and emits ms_mailbox_ooo_detected", async () => {
    // /me probe
    fetchMock.mockResolvedValueOnce(okResponse({ id: "ms-u" }));
    // auto-reply fetch
    fetchMock.mockResolvedValueOnce(okResponse({
      status: "alwaysEnabled",
      externalAudience: "all",
      internalReplyMessage: "out",
      externalReplyMessage: "out",
    }));
    const { refreshOwnOOOState } = await import("@/lib/integrations/microsoft-mailbox");
    const state = await refreshOwnOOOState("u");
    expect(state?.isEnabled).toBe(true);
    expect(state?.scope).toBe("all");
    expect(state?.msUserId).toBe("ms-u");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_mailbox_ooo_detected",
      "u",
      "system",
      expect.objectContaining({ scope: "all" }),
    );
    expect(mockQuery).toHaveBeenCalled(); // upsert
  });

  it("persists disabled OOO without emitting ooo_detected", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: "ms-u" }));
    fetchMock.mockResolvedValueOnce(okResponse({
      status: "disabled",
      externalAudience: "none",
    }));
    const { refreshOwnOOOState } = await import("@/lib/integrations/microsoft-mailbox");
    const state = await refreshOwnOOOState("u");
    expect(state?.isEnabled).toBe(false);
    const detected = mockTrack.mock.calls.filter(
      (c) => c[0] === "system.ms_mailbox_ooo_detected",
    );
    expect(detected).toHaveLength(0);
  });

  it("returns null when token missing", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { refreshOwnOOOState } = await import("@/lib/integrations/microsoft-mailbox");
    expect(await refreshOwnOOOState("u")).toBeNull();
  });
});

describe("getCachedOOOState", () => {
  it("returns null when empty", async () => {
    const { getCachedOOOState } = await import("@/lib/integrations/microsoft-mailbox");
    expect(await getCachedOOOState("u")).toBeNull();
  });

  it("maps row to OOOState", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        user_id: "u",
        ms_user_id: "ms-u",
        is_enabled: true,
        scope: "all",
        start_at: new Date().toISOString(),
        end_at: new Date(Date.now() + 60_000).toISOString(),
        internal_reply_message: null,
        external_reply_message: null,
        synced_at: new Date().toISOString(),
      }],
      fromCache: false,
    });
    const { getCachedOOOState } = await import("@/lib/integrations/microsoft-mailbox");
    const state = await getCachedOOOState("u");
    expect(state?.isEnabled).toBe(true);
    expect(state?.scope).toBe("all");
  });
});
