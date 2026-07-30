/**
 * API: GET /api/ms/chats/unread-count.
 *
 * Covers:
 *   - 401 without auth
 *   - connected:false when no MS token
 *   - scope_missing passthrough
 *   - first-poll (no ?since=) returns 0 even with fresh chats
 *   - filters chats whose lastUpdatedDateTime > since
 *   - malformed ?since= is treated as "first poll"
 *   - 500 on unexpected throw
 *   - analytics event `messages.unread_count_polled` fires on every
 *     resolved path (happy, connected:false, scope_missing)
 */
 

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

const mockListChatsResult = jest.fn();
const mockGetGraphMe = jest.fn();
jest.mock("@/lib/ms-graph-chats", () => ({
  listChatsResult: (...a: any[]) => mockListChatsResult(...a),
  getGraphMe: (...a: any[]) => mockGetGraphMe(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

const USER = { id: "u1", email: "a@x.com", role: "dev" };

beforeEach(() => {
  jest.clearAllMocks();
  // Default self identity so getGraphMe resolves for the counting paths. The id
  // and email are chosen not to collide with the other-sender fixtures, which
  // carry no userId and an "x@x" email, so they still count.
  mockGetGraphMe.mockResolvedValue({
    id: "self-id",
    mail: "self@x.com",
    userPrincipalName: "self@x.com",
    displayName: "Self",
  });
});

describe("GET /api/ms/chats/unread-count", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count"));
    expect(res.status).toBe(401);
  });

  it("200 { count:0, connected:false } when no MS token + fires analytics", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue(null);

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0, connected: false });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.unread_count_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, connected: false }),
    );
  });

  it("200 { count:0, scope_missing:true } when lib reports scope_missing + fires analytics", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "Chat.Read",
    });

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0, scope_missing: true });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.unread_count_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, scope_missing: true }),
    );
  });

  it("first poll (no ?since=) returns 0 even when there are fresh chats", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "c1", topic: "", chatType: "group", lastUpdatedDateTime: "2030-01-01T00:00:00Z", members: [] },
        { id: "c2", topic: "", chatType: "group", lastUpdatedDateTime: "2030-01-02T00:00:00Z", members: [] },
      ],
    });

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.total_chats).toBe(2);
    expect(body.since).toBeNull();
  });

  it("counts only chats whose lastUpdatedDateTime > since AND have a non-empty message body", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    const withBody = (text: string) => ({
      body: { content: text, contentType: "text" as const },
      bodyText: text,
      from: { displayName: "x", email: "x@x" },
      createdDateTime: "2026-04-23T12:00:00Z",
    });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "stale", topic: "", chatType: "group", lastUpdatedDateTime: "2026-04-20T00:00:00Z", members: [], lastMessagePreview: withBody("old message") },
        { id: "fresh1", topic: "", chatType: "group", lastUpdatedDateTime: "2026-04-23T10:00:00Z", members: [], lastMessagePreview: withBody("hello") },
        { id: "fresh2", topic: "", chatType: "group", lastUpdatedDateTime: "2026-04-23T12:00:00Z", members: [], lastMessagePreview: withBody("ping") },
        { id: "invalid", topic: "", chatType: "group", lastUpdatedDateTime: "not-a-date", members: [], lastMessagePreview: withBody("never") },
      ],
    });

    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.total_chats).toBe(4);
    expect(body.since).toBe(new Date(since).toISOString());

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.unread_count_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 2, total_chats: 4, has_since: true }),
    );
  });

  it("does NOT count a chat whose latest message the current user sent (self)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "t", userEmail: "self@x.com" });
    const preview = (text: string, from: any) => ({
      id: "m",
      body: { content: text, contentType: "text" },
      bodyText: text,
      from,
      createdDateTime: "2026-04-23T10:00:00Z",
    });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        // The user's own outbound message: same Graph id as self -> excluded.
        { id: "mine", topic: "", chatType: "oneOnOne", lastUpdatedDateTime: "2026-04-23T10:00:00Z", members: [], lastMessagePreview: preview("I sent this", { displayName: "Me", email: "self@x.com", userId: "self-id" }) },
        // A message from the other participant -> counts.
        { id: "theirs", topic: "", chatType: "oneOnOne", lastUpdatedDateTime: "2026-04-23T11:00:00Z", members: [], lastMessagePreview: preview("they replied", { displayName: "Them", email: "them@x.com", userId: "other-id" }) },
      ],
    });
    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(mockGetGraphMe).toHaveBeenCalled();
  });

  it("matches self by email when the sender's Graph user id is absent (case-insensitive)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "t", userEmail: "self@x.com" });
    const preview = (text: string, from: any) => ({
      id: "m",
      body: { content: text, contentType: "text" },
      bodyText: text,
      from,
      createdDateTime: "2026-04-23T10:00:00Z",
    });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "mine", topic: "", chatType: "oneOnOne", lastUpdatedDateTime: "2026-04-23T10:00:00Z", members: [], lastMessagePreview: preview("mine, no id", { displayName: "Me", email: "SELF@x.com" }) },
      ],
    });
    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it("does NOT count chats whose lastMessagePreview has no body text (system / meeting events)", async () => {
    /* Regression for the 2026-05-14 screenshot: Messages(1) badge fired on
       a chat whose timeline rendered only empty bubbles because Graph
       returned lastUpdatedDateTime for meeting/system events with no
       displayable body. The badge should silence those. */
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    const empty = {
      body: { content: "", contentType: "text" as const },
      bodyText: "",
      from: { displayName: "system", email: "system@teams" },
      createdDateTime: "2026-04-23T11:00:00Z",
    };
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        // Chat A: fresh timestamp, empty body → must NOT count
        { id: "meeting-only", topic: "Automating Coaching Calls", chatType: "meeting", lastUpdatedDateTime: "2026-04-23T11:00:00Z", members: [], lastMessagePreview: empty },
        // Chat B: fresh timestamp, missing preview entirely → must NOT count
        { id: "no-preview", topic: "Bot updates", chatType: "group", lastUpdatedDateTime: "2026-04-23T11:30:00Z", members: [] },
        // Chat C: fresh timestamp, real message text → must count
        { id: "real-msg", topic: "team chat", chatType: "group", lastUpdatedDateTime: "2026-04-23T11:45:00Z", members: [], lastMessagePreview: { body: { content: "hey", contentType: "text" as const }, bodyText: "hey", from: { displayName: "Nick", email: "n@x" }, createdDateTime: "2026-04-23T11:45:00Z" } },
      ],
    });

    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.total_chats).toBe(3);
  });

  it("does NOT count chats whose lastMessagePreview is a systemEventMessage (call ended, members added, meeting started)", async () => {
    /* Regression 2026-06-01: Homyk-OOO chat surfaced an unread badge
       whose preview body contained Teams custom tags (`<emoji></emoji>`,
       `<at id="0"></at>`) that resolve to empty bodyText after the
       parser. We now also exclude any preview whose messageType is
       explicitly `systemEventMessage` even if bodyText looks present
       (Graph occasionally puts inline metadata there). */
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        {
          id: "sysevent",
          topic: "Coaching call",
          chatType: "meeting",
          lastUpdatedDateTime: "2026-04-23T11:00:00Z",
          members: [],
          lastMessagePreview: {
            body: { content: "Call ended", contentType: "text" as const },
            bodyText: "Call ended",
            from: { displayName: "system", email: "" },
            createdDateTime: "2026-04-23T11:00:00Z",
            messageType: "systemEventMessage",
          },
        },
        {
          id: "real",
          topic: "team chat",
          chatType: "group",
          lastUpdatedDateTime: "2026-04-23T11:30:00Z",
          members: [],
          lastMessagePreview: {
            body: { content: "hey", contentType: "text" as const },
            bodyText: "hey",
            from: { displayName: "Nick", email: "n@x" },
            createdDateTime: "2026-04-23T11:30:00Z",
          },
        },
      ],
    });

    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.total_chats).toBe(2);
  });

  it("does NOT count a meeting-invite chat (preview carries eventDetail) even with body text", async () => {
    /* Regression for the 2026-06-19 screenshot: a Teams meeting invite
       ("Next Steps: A Weekend with Porsche") flashed a blank "new message"
       notification. The invite preview has a non-empty body but carries
       eventDetail (Graph attaches it only to system/meeting events), so the
       timeline drops it while the badge previously counted it. The badge must
       now agree with the timeline and skip it. */
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        {
          id: "meeting-invite",
          topic: "Next Steps: A Weekend with Porsche",
          chatType: "meeting",
          lastUpdatedDateTime: "2026-04-23T11:00:00Z",
          members: [],
          lastMessagePreview: {
            body: { content: "Next Steps: A Weekend with Porsche", contentType: "text" as const },
            bodyText: "Next Steps: A Weekend with Porsche",
            from: { displayName: "Organizer", email: "org@x" },
            createdDateTime: "2026-04-23T11:00:00Z",
            messageType: "message",
            eventDetail: { subtype: "meetingStarted" },
          },
        },
        {
          id: "attachment-card",
          topic: "Deck",
          chatType: "group",
          lastUpdatedDateTime: "2026-04-23T11:15:00Z",
          members: [],
          lastMessagePreview: {
            body: { content: "", contentType: "text" as const },
            bodyText: "",
            from: { displayName: "Sam", email: "s@x" },
            createdDateTime: "2026-04-23T11:15:00Z",
            messageType: "message",
            attachments: [
              { contentType: "application/vnd.microsoft.card.meeting", name: "Meeting" },
            ],
          },
        },
        {
          id: "real",
          topic: "team chat",
          chatType: "group",
          lastUpdatedDateTime: "2026-04-23T11:30:00Z",
          members: [],
          lastMessagePreview: {
            body: { content: "hey", contentType: "text" as const },
            bodyText: "hey",
            from: { displayName: "Nick", email: "n@x" },
            createdDateTime: "2026-04-23T11:30:00Z",
            messageType: "message",
          },
        },
      ],
    });

    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the real typed message counts; the meeting invite + card are skipped.
    expect(body.count).toBe(1);
    expect(body.total_chats).toBe(3);
  });

  it("does NOT count chats whose lastMessagePreview was deleted", async () => {
    /* Graph sets `deletedDateTime` when the sender tombstones the
       message. body is usually blanked too, but the explicit signal
       wins — a deleted-then-restored message still has the timestamp
       and would otherwise flash the badge. */
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        {
          id: "tombstoned",
          topic: "Direct chat",
          chatType: "oneOnOne",
          lastUpdatedDateTime: "2026-04-23T11:00:00Z",
          members: [],
          lastMessagePreview: {
            body: { content: "<div>this was a message</div>", contentType: "html" as const },
            bodyText: "this was a message",
            from: { displayName: "Sam", email: "s@x" },
            createdDateTime: "2026-04-23T11:00:00Z",
            deletedDateTime: "2026-04-23T11:05:00Z",
          },
        },
      ],
    });

    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.total_chats).toBe(1);
  });

  it("malformed ?since= is treated as first poll (count 0)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "fresh", topic: "", chatType: "group", lastUpdatedDateTime: "2030-01-02T00:00:00Z", members: [] },
      ],
    });

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count?since=not-a-date", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.since).toBeNull();
  });

  it("500 when the lib throws unexpectedly", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
