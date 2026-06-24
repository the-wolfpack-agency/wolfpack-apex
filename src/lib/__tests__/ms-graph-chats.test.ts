/**
 * Unit tests for src/lib/ms-graph-chats.ts — Graph response parsing,
 * HTML→text normalization, scope_missing handling, analytics wiring.
 */
 

export {};

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

const fetchMock = jest.fn();
beforeAll(() => {
  (global as any).fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
  mockTrack.mockReset();
});

import {
  listChats,
  listChatsResult,
  getChat,
  getChatMessages,
  getChatMessagesResult,
  sendChatMessage,
  sanitizeComposeHtml,
  stripHtml,
  normalizeEventSubtype,
} from "@/lib/ms-graph-chats";

function okJson(data: any) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}
function errResp(status: number, body: any = { error: "err" }) {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("stripHtml", () => {
  it("removes tags and decodes entities", () => {
    expect(stripHtml("<p>Hi <b>Nick</b>&nbsp;there &amp; <br/>team</p>")).toBe(
      "Hi Nick there & team",
    );
  });
  it("handles null / undefined", () => {
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml(null)).toBe("");
  });
  it("strips <script> and <style> blocks entirely", () => {
    expect(stripHtml("<style>.x{}</style>hello<script>alert(1)</script>")).toBe(
      "hello",
    );
  });
});

describe("listChats", () => {
  it("parses Graph { value: [...] } and normalizes HTML body to bodyText", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "chat-1",
            topic: "Team sync",
            chatType: "group",
            lastUpdatedDateTime: "2026-04-22T12:00:00Z",
            members: [
              { displayName: "Alice", email: "alice@x.com", userId: "u-alice" },
              { displayName: "Bob", email: "bob@x.com", userId: "u-bob" },
            ],
            lastMessagePreview: {
              body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
              from: {
                user: {
                  id: "u-alice",
                  displayName: "Alice",
                  email: "alice@x.com",
                },
              },
              createdDateTime: "2026-04-22T11:59:00Z",
            },
          },
        ],
      }),
    );

    const chats = await listChats("TOKEN", 10, "user-123");

    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe("chat-1");
    expect(chats[0].members).toHaveLength(2);
    expect(chats[0].lastMessagePreview?.bodyText).toBe("Hello world");
    expect(chats[0].lastMessagePreview?.body.contentType).toBe("html");
    expect(chats[0].lastMessagePreview?.from.email).toBe("alice@x.com");

    // Graph URL should include $top, $orderby, and MUST expand both
    // `members` AND `lastMessagePreview`. Without lastMessagePreview
    // in $expand, Graph returns a stale cached preview and ignores
    // the orderby → the /messages left rail shows "1d" for chats
    // that got a reply 7m ago (April 2026 regression).
    const url = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(url).toContain("/me/chats");
    expect(url).toContain("$top=10");
    expect(url).toContain("$expand=members,lastMessagePreview");
    expect(url).toContain(encodeURIComponent("lastMessagePreview/createdDateTime desc"));

    expect(mockTrack).toHaveBeenCalledWith(
      "ms_chats.listed",
      "user-123",
      "system",
      { count: 1 },
    );
  });

  it("returns [] and emits scope_missing on 401", async () => {
    fetchMock.mockResolvedValueOnce(errResp(401));
    const chats = await listChats("TOKEN", 10, "user-123");
    expect(chats).toEqual([]);
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_chats.scope_missing",
      "user-123",
      "system",
      {},
    );
  });

  it("returns [] on 500 and logs warn (no throw)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(errResp(500));
    const chats = await listChats("TOKEN", 5, "u");
    expect(chats).toEqual([]);
    warn.mockRestore();
  });

  it("listChatsResult surfaces scope_missing discriminator on 403", async () => {
    fetchMock.mockResolvedValueOnce(errResp(403));
    const result = await listChatsResult("TOKEN", 5, "u");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("scope_missing");
      expect(result.scope).toBe("Chat.Read");
    }
  });

  it("clamps limit to [1..50]", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [] }));
    await listChats("T", 1000, "u");
    const url = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(url).toContain("$top=50");
  });
});

describe("getChatMessages", () => {
  it("parses messages and strips HTML into bodyText", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "m1",
            from: {
              user: { id: "u1", displayName: "Alice", email: "alice@x.com" },
            },
            body: { content: "<p>hi there</p>", contentType: "html" },
            createdDateTime: "2026-04-22T12:00:00Z",
          },
          {
            id: "m2",
            from: {
              user: { id: "u2", displayName: "Bob", email: "bob@x.com" },
            },
            body: { content: "plain", contentType: "text" },
            createdDateTime: "2026-04-22T12:01:00Z",
          },
        ],
      }),
    );

    const messages = await getChatMessages("T", "chat-1", 20, "u");
    expect(messages).toHaveLength(2);
    expect(messages[0].bodyText).toBe("hi there");
    expect(messages[0].body.contentType).toBe("html");
    expect(messages[1].bodyText).toBe("plain");
    expect(messages[1].body.contentType).toBe("text");

    const url = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(url).toContain("/me/chats/chat-1/messages");

    expect(mockTrack).toHaveBeenCalledWith(
      "ms_chats.messages_loaded",
      "u",
      "system",
      { chat_id: "chat-1", count: 2 },
    );
  });

  it("getChatMessagesResult returns scope_missing on 401", async () => {
    fetchMock.mockResolvedValueOnce(errResp(401));
    const res = await getChatMessagesResult("T", "c", 10, "u");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("scope_missing");
  });
});

describe("sanitizeComposeHtml", () => {
  it("removes <script> blocks with contents", () => {
    expect(sanitizeComposeHtml("hello<script>alert(1)</script> world")).toBe(
      "hello world",
    );
  });
  it("removes <style> blocks with contents", () => {
    expect(sanitizeComposeHtml("<style>.x{}</style>hi")).toBe("hi");
  });
  it("strips event handlers on attributes", () => {
    const out = sanitizeComposeHtml(`<a href="/x" onclick="steal()">click</a>`);
    expect(out).not.toContain("onclick");
    expect(out).toContain("href=");
  });
  it("strips unquoted event handlers", () => {
    const out = sanitizeComposeHtml(`<a onmouseover=x()>y</a>`);
    expect(out).not.toContain("onmouseover");
  });
  it("neutralizes javascript: URLs", () => {
    const out = sanitizeComposeHtml(`<a href="javascript:alert(1)">x</a>`);
    expect(out).not.toContain("javascript:");
    expect(out).toContain(`href="#"`);
  });
  it("strips <iframe>", () => {
    const out = sanitizeComposeHtml(`hello<iframe src="//evil"></iframe>!`);
    expect(out).not.toContain("iframe");
  });
  it("leaves benign markup intact", () => {
    const out = sanitizeComposeHtml("<p>Hi <b>Nick</b></p>");
    expect(out).toBe("<p>Hi <b>Nick</b></p>");
  });
});

describe("sendChatMessage", () => {
  const SENT_MSG = {
    id: "m-new",
    from: {
      user: { id: "u-caller", displayName: "Caller", email: "caller@x.com" },
    },
    body: { content: "hi", contentType: "text" },
    createdDateTime: "2026-04-22T12:00:00Z",
  };

  it("POSTs to /me/chats/{id}/messages with the correct body + fires message_sent on 200", async () => {
    fetchMock.mockResolvedValueOnce(okJson(SENT_MSG));
    const res = await sendChatMessage("TOKEN", "chat-1", "hi", "text", "u1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.id).toBe("m-new");
      expect(res.message.bodyText).toBe("hi");
      expect(res.message.body.contentType).toBe("text");
    }

    const call = fetchMock.mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain("/me/chats/chat-1/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer TOKEN");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ body: { content: "hi", contentType: "text" } });

    expect(mockTrack).toHaveBeenCalledWith(
      "ms_chats.message_sent",
      "u1",
      "system",
      { chat_id: "chat-1", length: 2 },
    );
  });

  it("sanitizes HTML content BEFORE POSTing to Graph", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        ...SENT_MSG,
        body: { content: "<p>hi</p>", contentType: "html" },
      }),
    );
    const malicious = `<script>alert(1)</script>hi<a href="javascript:evil()">x</a>`;
    const res = await sendChatMessage("TOKEN", "c1", malicious, "html", "u1");
    expect(res.ok).toBe(true);

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    // script tag + contents stripped
    expect(sentBody.body.content).not.toContain("<script");
    expect(sentBody.body.content).not.toContain("alert(1)");
    // javascript: URL neutralized
    expect(sentBody.body.content).not.toContain("javascript:");
    // benign content preserved
    expect(sentBody.body.content).toContain("hi");
    expect(sentBody.body.contentType).toBe("html");
  });

  it("returns scope_missing on 401 (no throw, no analytics for message_sent)", async () => {
    fetchMock.mockResolvedValueOnce(errResp(401));
    const res = await sendChatMessage("TOKEN", "c1", "hi", "text", "u1");
    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "scope_missing") {
      expect(res.scope).toBe("Chat.ReadWrite");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_chats.scope_missing",
      "u1",
      "system",
      {},
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      "ms_chats.message_sent",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns scope_missing on 403", async () => {
    fetchMock.mockResolvedValueOnce(errResp(403));
    const res = await sendChatMessage("TOKEN", "c1", "hi", "text", "u1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("scope_missing");
  });

  it("returns {ok:false, code:'error'} on 500 and does NOT throw", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(errResp(500));
    const res = await sendChatMessage("TOKEN", "c1", "hi", "text", "u1");
    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "error") {
      expect(res.status).toBe(500);
    }
    warn.mockRestore();
  });

  it("returns {ok:false, code:'error', status:0} on network failure", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const res = await sendChatMessage("TOKEN", "c1", "hi", "text", "u1");
    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "error") {
      expect(res.status).toBe(0);
    }
    warn.mockRestore();
  });

  it("defaults contentType to 'text' when not provided", async () => {
    fetchMock.mockResolvedValueOnce(okJson(SENT_MSG));
    await sendChatMessage("TOKEN", "c1", "plain message");
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.body.contentType).toBe("text");
  });
});

describe("getChat", () => {
  it("returns chat meta on success", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        id: "c1",
        topic: "T",
        chatType: "oneOnOne",
        lastUpdatedDateTime: "2026-04-22T00:00:00Z",
        members: [{ displayName: "A", email: "a@x.com", userId: "u-a" }],
      }),
    );
    const res = await getChat("T", "c1", "u");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chat.id).toBe("c1");
  });

  it("returns not_found on 404", async () => {
    fetchMock.mockResolvedValueOnce(errResp(404));
    const res = await getChat("T", "c1", "u");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("returns scope_missing on 403", async () => {
    fetchMock.mockResolvedValueOnce(errResp(403));
    const res = await getChat("T", "c1", "u");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("scope_missing");
  });
});

describe("normalizeEventSubtype (Bug 1)", () => {
  it("strips namespace + EventMessageDetail suffix", () => {
    expect(
      normalizeEventSubtype("#microsoft.graph.callEndedEventMessageDetail"),
    ).toBe("callEnded");
    expect(
      normalizeEventSubtype("#microsoft.graph.membersAddedEventMessageDetail"),
    ).toBe("membersAdded");
    expect(
      normalizeEventSubtype("#microsoft.graph.topicUpdatedEventMessageDetail"),
    ).toBe("topicUpdated");
  });

  it("returns null for missing / non-string", () => {
    expect(normalizeEventSubtype(undefined)).toBeNull();
    expect(normalizeEventSubtype(null)).toBeNull();
    expect(normalizeEventSubtype(42)).toBeNull();
    expect(normalizeEventSubtype("")).toBeNull();
  });

  it("handles bare values (no namespace)", () => {
    expect(normalizeEventSubtype("callEnded")).toBe("callEnded");
  });
});

describe("normalizeMessage extensions (Bug 1)", () => {
  it("surfaces messageType + attachments + eventDetail through getChatMessagesResult", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "m-call",
            createdDateTime: "2026-04-29T10:00:00Z",
            messageType: "systemEventMessage",
            eventDetail: {
              "@odata.type": "#microsoft.graph.callEndedEventMessageDetail",
            },
            from: null,
            body: { content: "", contentType: "html" },
          },
          {
            id: "m-attach",
            createdDateTime: "2026-04-29T10:05:00Z",
            messageType: "message",
            attachments: [
              { contentType: "reference", name: "budget.xlsx" },
            ],
            from: null,
            body: { content: "", contentType: "html" },
          },
          {
            id: "m-text",
            createdDateTime: "2026-04-29T10:10:00Z",
            messageType: "message",
            from: null,
            body: { content: "hello", contentType: "text" },
          },
        ],
      }),
    );
    const res = await getChatMessagesResult("T", "c1", 30, "u");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = Object.fromEntries(res.messages.map((m) => [m.id, m]));
    expect(byId["m-call"].messageType).toBe("systemEventMessage");
    expect(byId["m-call"].eventDetail?.subtype).toBe("callEnded");
    expect(byId["m-attach"].attachments?.[0].name).toBe("budget.xlsx");
    expect(byId["m-text"].messageType).toBe("message");
    expect(byId["m-text"].attachments).toBeUndefined();
  });

  it("surfaces deletedDateTime so renderers can hide tombstoned bubbles (2026-06-01)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "m-deleted",
            createdDateTime: "2026-05-11T10:00:00Z",
            deletedDateTime: "2026-05-11T10:01:00Z",
            messageType: "message",
            from: null,
            body: { content: "<div></div>", contentType: "html" },
          },
          {
            id: "m-live",
            createdDateTime: "2026-05-11T10:05:00Z",
            messageType: "message",
            from: null,
            body: { content: "still here", contentType: "text" },
          },
        ],
      }),
    );
    const res = await getChatMessagesResult("T", "c1", 30, "u");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = Object.fromEntries(res.messages.map((m) => [m.id, m]));
    expect(byId["m-deleted"].deletedDateTime).toBe("2026-05-11T10:01:00Z");
    expect(byId["m-live"].deletedDateTime).toBeUndefined();
  });

  it("surfaces lastMessagePreview.messageType + deletedDateTime on Chat (2026-06-01)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "c-sysevent",
            topic: "Coaching",
            chatType: "meeting",
            lastUpdatedDateTime: "2026-05-11T11:00:00Z",
            members: [],
            lastMessagePreview: {
              body: { content: "Call ended", contentType: "text" },
              from: { user: { displayName: "system", email: "" } },
              createdDateTime: "2026-05-11T11:00:00Z",
              messageType: "systemEventMessage",
            },
          },
          {
            id: "c-deleted",
            topic: "Direct",
            chatType: "oneOnOne",
            lastUpdatedDateTime: "2026-05-11T12:00:00Z",
            members: [],
            lastMessagePreview: {
              body: { content: "<div></div>", contentType: "html" },
              from: { user: { displayName: "Sam", email: "s@x" } },
              createdDateTime: "2026-05-11T12:00:00Z",
              deletedDateTime: "2026-05-11T12:01:00Z",
            },
          },
        ],
      }),
    );
    const res = await listChatsResult("T", 25, "u");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = Object.fromEntries(res.chats.map((c) => [c.id, c]));
    expect(byId["c-sysevent"].lastMessagePreview?.messageType).toBe(
      "systemEventMessage",
    );
    expect(byId["c-deleted"].lastMessagePreview?.deletedDateTime).toBe(
      "2026-05-11T12:01:00Z",
    );
  });

  it("surfaces lastMessagePreview.eventDetail + attachments on Chat (2026-06-19)", async () => {
    // The meeting-invite fix: the preview must carry the same eventDetail +
    // attachment signals the timeline has, so the unread-count can tell a
    // meeting invite from a typed message.
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "c-meeting",
            topic: "Next Steps: A Weekend with Porsche",
            chatType: "meeting",
            lastUpdatedDateTime: "2026-06-19T11:00:00Z",
            members: [],
            lastMessagePreview: {
              body: { content: "Next Steps", contentType: "text" },
              from: { user: { displayName: "Organizer", email: "o@x" } },
              createdDateTime: "2026-06-19T11:00:00Z",
              messageType: "message",
              eventDetail: {
                "@odata.type": "#microsoft.graph.meetingStartedEventMessageDetail",
              },
            },
          },
          {
            id: "c-card",
            topic: "Deck",
            chatType: "group",
            lastUpdatedDateTime: "2026-06-19T11:30:00Z",
            members: [],
            lastMessagePreview: {
              body: { content: "", contentType: "text" },
              from: { user: { displayName: "Sam", email: "s@x" } },
              createdDateTime: "2026-06-19T11:30:00Z",
              messageType: "message",
              attachments: [
                { contentType: "application/vnd.microsoft.card.meeting", name: "Meeting" },
              ],
            },
          },
        ],
      }),
    );
    const res = await listChatsResult("T", 25, "u");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = Object.fromEntries(res.chats.map((c) => [c.id, c]));
    expect(byId["c-meeting"].lastMessagePreview?.eventDetail?.subtype).toBe("meetingStarted");
    expect(byId["c-card"].lastMessagePreview?.attachments?.[0].name).toBe("Meeting");
  });
});
