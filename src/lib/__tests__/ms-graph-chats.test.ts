/**
 * Unit tests for src/lib/ms-graph-chats.ts — Graph response parsing,
 * HTML→text normalization, scope_missing handling, analytics wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

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
  stripHtml,
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

    // Graph URL should include $top, $orderby, $expand=members.
    const url = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(url).toContain("/me/chats");
    expect(url).toContain("$top=10");
    expect(url).toContain("$expand=members");
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
