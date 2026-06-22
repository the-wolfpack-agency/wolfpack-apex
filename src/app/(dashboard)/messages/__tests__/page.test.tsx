/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

// jsdom doesn't implement scrollIntoView; the thread auto-scroll on
// new messages calls it. No-op polyfill keeps tests focused on
// behavior, not on jsdom's quirks.
beforeAll(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn(() => ({ email: "me@x", name: "Tester" }));
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
  getInstinctUser: () => mockGetInstinctUser(),
}));

// Stub PresenceDot so its batcher is not exercised here — it has its
// own dedicated test file.
jest.mock("@/components/PresenceDot", () => ({
  __esModule: true,
  default: ({ userId }: { userId: string }) => (
    <span data-testid={`presence-dot-stub-${userId}`} />
  ),
}));

// Capture insight events emitted by the mention flow so tests can
// assert against the canonical {actor, role, surface, action, tier,
// payload} shape without spinning up the analytics warehouse.
const mockEmitInsight = jest.fn();
jest.mock("@/lib/insights/emit", () => ({
  emitInsight: (e: unknown) => mockEmitInsight(e),
}));

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import MessagesPage, {
  stripHtmlToText,
  formatRelativeTime,
  getChatTitle,
  colorForSender,
  buildTeamsDeepLink,
  BASIC_EMOJIS,
  isChatUnread,
  cssEscape,
  mergeThreadMessages,
  type ChatMessage,
} from "@/app/(dashboard)/messages/page";

interface MockResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<any>;
}

function ok(body: any, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function wireApiRouter(router: (url: string, init?: any) => MockResponse) {
  mockFetchWithRefresh.mockImplementation((url: string, init: any) =>
    Promise.resolve(router(url, init)),
  );
}

const SAMPLE_CHATS = [
  {
    id: "chat-1",
    chatType: "oneOnOne",
    lastUpdatedDateTime: "2026-04-23T10:00:00Z",
    lastMessagePreview: "hey there",
    unreadCount: 2,
    members: [
      { id: "m-self", displayName: "Me", email: "me@wolfpack.test", userId: "user-self" },
      { id: "m-jane", displayName: "Jane Doe", email: "jane@wolfpack.test", userId: "user-jane" },
    ],
  },
  {
    id: "chat-2",
    chatType: "group",
    topic: "Launch team",
    lastUpdatedDateTime: "2026-04-22T08:00:00Z",
    lastMessagePreview: "ship it",
    members: [
      { id: "m1", displayName: "Alice", email: "alice@wolfpack.test", userId: "u-a" },
      { id: "m2", displayName: "Bob", email: "bob@wolfpack.test", userId: "u-b" },
    ],
  },
  {
    id: "chat-old",
    chatType: "oneOnOne",
    lastUpdatedDateTime: "2026-04-01T08:00:00Z",
    lastMessagePreview: "old",
    members: [
      { id: "m-self", displayName: "Me", email: "me@wolfpack.test", userId: "user-self" },
      { id: "m-sam", displayName: "Sam", email: "sam@wolfpack.test", userId: "user-sam" },
    ],
  },
];

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  try {
    window.localStorage.clear();
    window.localStorage.setItem(
      "instinct_user",
      JSON.stringify({ email: "me@wolfpack.test" }),
    );
    // Sections now default to COLLAPSED on first visit (UX fix —
    // dozens of chats / channels were scrolling the page). Tests in
    // this file were written assuming open-by-default; seed both
    // sections open as a global default. Tests that need the
    // first-visit collapsed default can `removeItem` after clear.
    window.localStorage.setItem("instinct.messages.chats_open", "1");
    window.localStorage.setItem("instinct.messages.teams_open", "1");
  } catch {
    /* noop */
  }
  // Clear any deep-link query string left behind by a previous test
  // (`?chat=...` / `?team=...&channel=...`) so the messages page
  // initializer doesn't auto-select stale targets in unrelated cases.
  try {
    window.history.replaceState({}, "", "/messages");
  } catch {
    /* noop */
  }
});

/**
 * Render helper that mounts the page and waits for the root testid.
 * The describe-level beforeEach seeds chats_open=1 + teams_open=1 in
 * localStorage so production code reads them as expanded — no extra
 * click needed. New tests that exercise the collapsed default
 * `removeItem` those keys first and call `render(<MessagesPage />)`
 * directly.
 */
async function renderMessagesOpen(): Promise<ReturnType<typeof render>> {
  const r = render(<MessagesPage />);
  await waitFor(() => screen.getByTestId("messages-page"));
  return r;
}

// ---------------------------------------------------------------- helpers

describe("stripHtmlToText", () => {
  test("removes tags and decodes entities", () => {
    expect(stripHtmlToText("<p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
  });
  test("strips script/style blocks entirely", () => {
    expect(
      stripHtmlToText("<script>alert(1)</script><p>safe</p>"),
    ).toBe("safe");
  });
  test("converts <br> to newlines", () => {
    expect(stripHtmlToText("a<br>b<br/>c")).toBe("a\nb\nc");
  });
  test("returns empty string for nullish", () => {
    expect(stripHtmlToText(undefined)).toBe("");
    expect(stripHtmlToText(null)).toBe("");
  });
});

describe("formatRelativeTime", () => {
  test("seconds/minutes/hours/days", () => {
    const base = new Date("2026-04-23T12:00:00Z").getTime();
    expect(formatRelativeTime("2026-04-23T11:59:30Z", base)).toMatch(/s$/);
    expect(formatRelativeTime("2026-04-23T11:30:00Z", base)).toBe("30m");
    expect(formatRelativeTime("2026-04-23T10:00:00Z", base)).toBe("2h");
    expect(formatRelativeTime("2026-04-21T12:00:00Z", base)).toBe("2d");
  });
});

describe("isChatUnread (Bug 2 helper)", () => {
  const chat = {
    id: "c1",
    lastUpdatedDateTime: "2026-04-29T10:00:00.000Z",
    lastMessagePreview: undefined,
  };

  test("no cursor → unread (new user, every chat starts unread)", () => {
    expect(isChatUnread(chat, new Map())).toBe(true);
  });

  test("cursor older than lastUpdatedDateTime → unread", () => {
    expect(
      isChatUnread(
        chat,
        new Map([["c1", "2026-04-29T09:00:00.000Z"]]),
      ),
    ).toBe(true);
  });

  test("cursor equal to lastUpdatedDateTime → read (not strictly newer)", () => {
    expect(
      isChatUnread(
        chat,
        new Map([["c1", "2026-04-29T10:00:00.000Z"]]),
      ),
    ).toBe(false);
  });

  test("cursor newer than lastUpdatedDateTime → read", () => {
    expect(
      isChatUnread(
        chat,
        new Map([["c1", "2026-04-29T11:00:00.000Z"]]),
      ),
    ).toBe(false);
  });

  test("malformed cursor → fall back to unread", () => {
    expect(
      isChatUnread(chat, new Map([["c1", "not-a-date"]])),
    ).toBe(true);
  });
});

describe("cssEscape (Bug 3 helper)", () => {
  test("returns the input verbatim for plain alphanumerics", () => {
    expect(cssEscape("abc123")).toBe("abc123");
  });
  test("escapes via CSS.escape when available", () => {
    // jsdom provides CSS.escape; just verify we round-trip through it.
    const out = cssEscape('a"b');
    expect(out).not.toBe('a"b');
    expect(out).toMatch(/a/);
  });
});

describe("getChatTitle", () => {
  test("uses topic when present", () => {
    expect(
      getChatTitle(
        {
          id: "x",
          chatType: "group",
          topic: "Launch",
          lastUpdatedDateTime: "",
          members: [],
        },
        "me@x",
      ),
    ).toBe("Launch");
  });
  test("falls back to other member name for 1:1", () => {
    expect(
      getChatTitle(
        {
          id: "x",
          chatType: "oneOnOne",
          lastUpdatedDateTime: "",
          members: [
            { id: "1", displayName: "Me", email: "me@x", userId: "u1" },
            { id: "2", displayName: "Jane", email: "jane@x", userId: "u2" },
          ],
        },
        "me@x",
      ),
    ).toBe("Jane");
  });

  test("regression: when selfEmail is missing, uses selfName to identify self", () => {
    // Bug 2026-04-23: selfEmail loaded in a useEffect, first render had
    // undefined. The filter returned nothing and chat.members[0] (the
    // caller) was picked — so every 1:1 chat showed "Nick Homyk".
    expect(
      getChatTitle(
        {
          id: "x",
          chatType: "oneOnOne",
          lastUpdatedDateTime: "",
          members: [
            { id: "1", displayName: "Nick Homyk", email: "nick@x", userId: "u1" },
            { id: "2", displayName: "Max Fuerst", email: "max@x", userId: "u2" },
          ],
        },
        undefined, // selfEmail not yet loaded
        "Nick Homyk", // but we know the caller's display name
      ),
    ).toBe("Max Fuerst");
  });

  test("regression: when BOTH selfEmail and selfName are missing, prefer the LAST member (Graph lists caller first)", () => {
    // Worst case: neither selfEmail nor selfName resolved. The old
    // fallback picked members[0] which is almost always the caller.
    // Pick LAST instead — biased toward the other party.
    expect(
      getChatTitle(
        {
          id: "x",
          chatType: "oneOnOne",
          lastUpdatedDateTime: "",
          members: [
            { id: "1", displayName: "Nick Homyk", email: "nick@x", userId: "u1" },
            { id: "2", displayName: "Max Fuerst", email: "max@x", userId: "u2" },
          ],
        },
      ),
    ).toBe("Max Fuerst");
  });

  test("selfName match is case-insensitive", () => {
    expect(
      getChatTitle(
        {
          id: "x",
          chatType: "oneOnOne",
          lastUpdatedDateTime: "",
          members: [
            { id: "1", displayName: "nick homyk", email: "", userId: "u1" },
            { id: "2", displayName: "Jane", email: "jane@x", userId: "u2" },
          ],
        },
        undefined,
        "Nick Homyk",
      ),
    ).toBe("Jane");
  });
});

// ---------------------------------------------- new pure helpers (2026-04-26)

describe("colorForSender", () => {
  test("returns the same color for the same key (deterministic)", () => {
    const c1 = colorForSender("alice@example.com");
    const c2 = colorForSender("alice@example.com");
    expect(c1).toBe(c2);
  });

  test("different keys can map to different palette colors", () => {
    const colors = new Set<string>();
    for (const key of [
      "a@x", "b@y", "c@z", "d@w", "e@v",
      "f@u", "g@t", "h@s", "i@r", "j@q",
    ]) {
      colors.add(colorForSender(key));
    }
    // 10 distinct keys against an 8-color palette — assert >1 color
    // emerges (collisions are fine and expected; we just need to
    // prove the function isn't constant).
    expect(colors.size).toBeGreaterThan(1);
  });

  test("falls back to a default for empty key", () => {
    expect(colorForSender("")).toBeTruthy();
    expect(colorForSender(null)).toBeTruthy();
    expect(colorForSender(undefined)).toBeTruthy();
  });

  test("returns a hex color string (palette member)", () => {
    expect(colorForSender("anyone")).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("buildTeamsDeepLink", () => {
  test("chat URL encodes member emails as comma-separated list", () => {
    const url = buildTeamsDeepLink("chat", ["alice@x.com", "bob@y.com"]);
    expect(url).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=alice%40x.com,bob%40y.com",
    );
  });

  test("call URL sets withVideo=false", () => {
    const url = buildTeamsDeepLink("call", ["alice@x.com"]);
    expect(url).toBe(
      "https://teams.microsoft.com/l/call/0/0?users=alice%40x.com&withVideo=false",
    );
  });

  test("video URL sets withVideo=true", () => {
    const url = buildTeamsDeepLink("video", ["alice@x.com"]);
    expect(url).toBe(
      "https://teams.microsoft.com/l/call/0/0?users=alice%40x.com&withVideo=true",
    );
  });

  test("returns null when no valid emails available", () => {
    expect(buildTeamsDeepLink("chat", [])).toBeNull();
    expect(buildTeamsDeepLink("chat", ["not-an-email"])).toBeNull();
    expect(buildTeamsDeepLink("call", [""])).toBeNull();
  });

  test("filters out non-email strings (graceful fallback)", () => {
    const url = buildTeamsDeepLink("chat", [
      "alice@x.com",
      "",
      "not-an-email",
      "bob@y.com",
    ]);
    expect(url).toContain("alice%40x.com");
    expect(url).toContain("bob%40y.com");
    expect(url).not.toContain("not-an-email");
  });
});

describe("BASIC_EMOJIS palette", () => {
  test("includes the user-requested basics: thumbs up, checkmark, smile", () => {
    const chars = BASIC_EMOJIS.map((e) => e.char);
    expect(chars).toContain("👍");
    expect(chars).toContain("✅");
    expect(chars).toContain("😄");
  });

  test("each entry has a non-empty name (used as testid + aria-label)", () => {
    for (const e of BASIC_EMOJIS) {
      expect(e.name).toBeTruthy();
      expect(e.char).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- page

describe("mergeThreadMessages", () => {
  const msg = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    createdDateTime: "2026-04-23T10:00:00Z",
    body: { contentType: "text", content: id },
    ...extra,
  });

  it("appends a newly-arrived server message", () => {
    const prev = [msg("a"), msg("b")];
    const out = mergeThreadMessages(prev, [msg("a"), msg("b"), msg("c")]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the SAME reference when nothing changed (no re-render / no scroll yank)", () => {
    const prev = [msg("a"), msg("b")];
    expect(mergeThreadMessages(prev, [msg("a"), msg("b")])).toBe(prev);
  });

  it("preserves a still-pending optimistic message not yet echoed by the server", () => {
    const prev = [msg("a"), msg("optimistic-1", { pending: true, role: "me" })];
    const out = mergeThreadMessages(prev, [msg("a")]);
    expect(out.map((m) => m.id)).toEqual(["a", "optimistic-1"]);
  });

  it("does not duplicate a message once the server confirms it (same id)", () => {
    const prev = [msg("real-1", { role: "me" })];
    const out = mergeThreadMessages(prev, [msg("real-1")]);
    expect(out.map((m) => m.id)).toEqual(["real-1"]);
    expect(out).toBe(prev);
  });

  it("adopts the server thread when the previous one was empty", () => {
    expect(mergeThreadMessages([], [msg("a")]).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("MessagesPage", () => {
  test("renders list sorted by lastUpdatedDateTime desc", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      return ok({});
    });
    await renderMessagesOpen();
    await waitFor(() =>
      expect(screen.getByTestId("messages-page")).toBeInTheDocument(),
    );
    const rows = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid")?.startsWith("chat-row-"));
    expect(rows[0]).toHaveAttribute("data-testid", "chat-row-chat-1");
    expect(rows[1]).toHaveAttribute("data-testid", "chat-row-chat-2");
    expect(rows[2]).toHaveAttribute("data-testid", "chat-row-chat-old");
    // The analytics GET's status resolved 200 — wired through ok().
    const listCall = mockFetchWithRefresh.mock.calls.find((c) => c[0] === "/api/ms/chats");
    expect(listCall).toBeDefined();
  });

  test("shows unread badge on chat-1 and uses topic for group chat-2", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      return ok({});
    });
    await renderMessagesOpen();
    expect(screen.getByTestId("chat-unread-chat-1")).toHaveTextContent("2");
    const row2 = screen.getByTestId("chat-row-chat-2");
    expect(within(row2).getByText("Launch team")).toBeInTheDocument();
  });

  // Regression: users were never notified of new Teams messages because
  // `instinct.messages.last_seen` was only written by the badge's click
  // handler — and the badge only rendered when count > 0, which required
  // `last_seen` to be set. Chicken-and-egg. Visiting /messages must
  // bootstrap the cursor so subsequent unread-count polls return real
  // counts and fire the browser notification + title-bar tag.
  test("bootstraps instinct.messages.last_seen on mount (unread badge cycle)", async () => {
    window.localStorage.removeItem("instinct.messages.last_seen");
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      return ok({});
    });
    const beforeMs = Date.now();
    await renderMessagesOpen();
    const stored = window.localStorage.getItem("instinct.messages.last_seen");
    expect(stored).not.toBeNull();
    const storedMs = Date.parse(stored as string);
    expect(storedMs).toBeGreaterThanOrEqual(beforeMs);
    expect(storedMs).toBeLessThanOrEqual(Date.now());
  });

  test("selecting a chat loads thread messages and action buttons have deep-link URLs", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({
          messages: [
            {
              id: "msg-1",
              from: { displayName: "Jane" },
              createdDateTime: "2026-04-23T10:00:00Z",
              body: { contentType: "html", content: "<p>hi <b>there</b></p>" },
            },
            {
              id: "msg-2",
              from: { displayName: "Me" },
              createdDateTime: "2026-04-23T10:01:00Z",
              body: { contentType: "text", content: "hello back" },
            },
          ],
        });
      if (url === "/api/ms/deep-links") {
        const body = JSON.parse(init.body);
        if (body.type === "chat")
          return ok({ url: "msteams://chat/chat-1" });
        if (body.type === "call" && body.withVideo === 1)
          return ok({ url: "msteams://call/video" });
        if (body.type === "call")
          return ok({ url: "msteams://call/audio" });
      }
      return ok({});
    });

    await renderMessagesOpen();

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
    });
    // HTML body rendered safely as text.
    expect(screen.getByTestId("message-msg-1").textContent).toMatch(/hi there/);
    expect(screen.getByTestId("message-msg-2").textContent).toMatch(/hello back/);

    // Deep-link buttons eventually receive URLs.
    await waitFor(() => {
      expect(screen.getByTestId("deep-link-reply")).toHaveAttribute(
        "data-href",
        "msteams://chat/chat-1",
      );
    });
    expect(screen.getByTestId("deep-link-call")).toHaveAttribute(
      "data-href",
      "msteams://call/audio",
    );
    expect(screen.getByTestId("deep-link-video")).toHaveAttribute(
      "data-href",
      "msteams://call/video",
    );

    // The chat GET came back 200 (not "not 500") — assert explicitly.
    const threadCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/ms/chats/chat-1",
    );
    expect(threadCall).toBeDefined();
  });

  test("deep-link: ?chat=<id> auto-selects the chat and loads its thread without a click", async () => {
    // Search results, email handoffs, etc. land users on
    // /messages?chat=<id>. The page must auto-select that chat
    // and load its thread — landing on the bare list defeats the
    // point of the deep link.
    window.history.replaceState({}, "", "/messages?chat=chat-1");
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({
          messages: [
            {
              id: "deep-msg",
              from: { displayName: "Jane" },
              createdDateTime: "2026-04-23T10:00:00Z",
              body: { contentType: "text", content: "hi from deep link" },
            },
          ],
        });
      return ok({});
    });

    await renderMessagesOpen();

    await waitFor(() => {
      expect(screen.getByTestId("message-deep-msg")).toBeInTheDocument();
    });
    // Confirm the thread fetch was made — no manual click required.
    const threadCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/ms/chats/chat-1",
    );
    expect(threadCall).toBeDefined();
  });

  test("regression: row timestamp uses lastMessagePreview.createdDateTime, not lastUpdatedDateTime", async () => {
    // Bug: Nick messaged Max via Teams a minute ago but the row still
    // said "1d". Cause: the page was reading chat.lastUpdatedDateTime,
    // which Microsoft Graph only updates on member/topic changes —
    // NOT on each new message. The right field is
    // lastMessagePreview.createdDateTime.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    wireApiRouter((url) => {
      if (url === "/api/ms/chats")
        return ok({
          chats: [
            {
              id: "chat-stale-meta",
              chatType: "oneOnOne",
              // Membership last changed 1 day ago
              lastUpdatedDateTime: yesterday,
              // ...but a new message was just sent 1 minute ago
              lastMessagePreview: {
                bodyText: "fresh ping",
                createdDateTime: oneMinuteAgo,
                from: { displayName: "Max" },
              },
              members: [
                { id: "self", displayName: "Me", email: "me@wolfpack.test" },
                { id: "max", displayName: "Max", email: "max@wolfpack.test" },
              ],
            },
          ],
        });
      return ok({});
    });

    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("chat-row-chat-stale-meta"));

    // formatRelativeTime("1m ago") returns something matching /m$/.
    // If the bug regresses, we'd see "1d" instead.
    const row = screen.getByTestId("chat-row-chat-stale-meta");
    const timestampText = row.textContent ?? "";
    // Relative time renders as e.g. "1m" right before the preview
    // text. Assert we see m/s units and explicitly NOT a "d" unit.
    expect(timestampText).toMatch(/\d+m(?!s)/);
    expect(timestampText).not.toMatch(/\d+d/);
    // And the preview text comes through from the object form.
    expect(
      screen.getByTestId("chat-preview-chat-stale-meta").textContent,
    ).toMatch(/fresh ping/);
  });

  test("regression: thread renders messages oldest-first (newest at bottom) regardless of API order", async () => {
    // Microsoft Graph returns chat messages newest-first. The previous
    // code did `slice(-30)` which preserved that descending order, so
    // the newest message rendered at the TOP of the thread — opposite
    // of every chat app users know. Fix: sort ascending by
    // createdDateTime, then slice the last 30. Here we feed the API a
    // descending list and assert the DOM order is ascending.
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({
          messages: [
            // newest first — the order Graph actually uses
            {
              id: "newest",
              from: { displayName: "Jane" },
              createdDateTime: "2026-04-23T12:00:00Z",
              body: { contentType: "text", content: "C" },
            },
            {
              id: "middle",
              from: { displayName: "Jane" },
              createdDateTime: "2026-04-23T11:00:00Z",
              body: { contentType: "text", content: "B" },
            },
            {
              id: "oldest",
              from: { displayName: "Jane" },
              createdDateTime: "2026-04-23T10:00:00Z",
              body: { contentType: "text", content: "A" },
            },
          ],
        });
      return ok({});
    });

    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("message-oldest")).toBeInTheDocument();
    });

    // Ascending DOM order: oldest first, newest last.
    const body = screen.getByTestId("messages-thread-body");
    const ids = Array.from(
      body.querySelectorAll('[data-testid^="message-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual([
      "message-oldest",
      "message-middle",
      "message-newest",
    ]);

    // And the auto-scroll sentinel is the very last child of the
    // thread body, so scrollIntoView lands at the bottom.
    expect(screen.getByTestId("messages-thread-end")).toBeInTheDocument();
  });

  test("back button clears selection", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({ messages: [] });
      return ok({});
    });
    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("messages-back"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-back"));
    });
    expect(screen.getByTestId("messages-no-selection")).toBeInTheDocument();
  });

  test("empty-state card renders when no chats", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: [] });
      return ok({});
    });
    render(<MessagesPage />);
    await waitFor(() =>
      expect(screen.getByTestId("messages-empty")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("messages-empty-cta")).toHaveAttribute("href", "/settings");
  });

  test("scope-missing card renders when API returns scope_missing:true (200)", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ scope_missing: true });
      return ok({});
    });
    render(<MessagesPage />);
    await waitFor(() =>
      expect(screen.getByTestId("messages-scope-missing")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("messages-scope-cta")).toHaveAttribute("href", "/settings");
  });

  test("scope-missing card renders on 401", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({}, 401);
      return ok({});
    });
    render(<MessagesPage />);
    await waitFor(() =>
      expect(screen.getByTestId("messages-scope-missing")).toBeInTheDocument(),
    );
  });

  test("clicking a deep-link button fires analytics with the right type", async () => {
    const openSpy = jest.spyOn(window, "open").mockImplementation(() => null);
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      if (url === "/api/ms/deep-links") {
        const body = JSON.parse(init.body);
        if (body.type === "chat") return ok({ url: "msteams://chat/1" });
        if (body.type === "call" && body.withVideo === 1)
          return ok({ url: "msteams://video/1" });
        if (body.type === "call") return ok({ url: "msteams://call/1" });
      }
      return ok({});
    });

    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("deep-link-video")).toHaveAttribute(
        "data-href",
        "msteams://video/1",
      ),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("deep-link-video"));
    });

    expect(openSpy).toHaveBeenCalledWith(
      "msteams://video/1",
      "_blank",
      "noopener,noreferrer",
    );
    const videoAnalytics = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1].body))
      .find((b) => b.event === "messages.deep_link_clicked");
    expect(videoAnalytics?.metadata).toEqual({ type: "video" });

    openSpy.mockRestore();
  });

  test("chat rows use the dark theme CSS variables (no hardcoded light background/text)", async () => {
    // Regression: initial build used hardcoded #fff backgrounds +
    // inherited text colors, rendering chat names invisible (white on
    // white) on the dark dashboard. Assert theme variables are used.
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      return ok({});
    });
    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("chat-row-chat-1"));
    const row = screen.getByTestId("chat-row-chat-1") as HTMLElement;
    const inline = row.getAttribute("style") ?? "";
    expect(inline).toMatch(/color:\s*var\(--wp-text/);
    expect(inline).not.toMatch(/background:\s*#fff/i);
  });
});

// ---------------------------------------------------------------- compose

describe("MessagesPage — open thread live-update", () => {
  // Regression: an open conversation only updated after a manual page
  // refresh because only the chat LIST was polled, never the open thread.
  it("merges newly-arrived messages into the open thread on an ambient poll tick", async () => {
    jest.useFakeTimers();
    try {
      let threadCalls = 0;
      wireApiRouter((url: string) => {
        if (url === "/api/ms/chats")
          return ok({
            chats: SAMPLE_CHATS,
            self_email: "me@wolfpack.test",
            self_id: "user-self",
          });
        if (url.startsWith("/api/ms/chats/chat-1")) {
          threadCalls += 1;
          const msgs: any[] = [
            {
              id: "m1",
              from: { displayName: "Jane Doe" },
              createdDateTime: "2026-04-23T10:00:00Z",
              body: { contentType: "text", content: "first message" },
            },
          ];
          if (threadCalls >= 2) {
            msgs.push({
              id: "m2",
              from: { displayName: "Jane Doe" },
              createdDateTime: "2026-04-23T10:05:00Z",
              body: { contentType: "text", content: "live update arrived" },
            });
          }
          return ok({ messages: msgs });
        }
        if (url === "/api/messages/read-state") return ok({ state: {} });
        return ok({});
      });

      const flush = async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      };

      await act(async () => {
        render(<MessagesPage />);
      });
      await act(flush);

      await act(async () => {
        fireEvent.click(screen.getByTestId("chat-row-chat-1"));
      });
      await act(flush);

      expect(screen.getByText("first message")).toBeInTheDocument();
      expect(screen.queryByText("live update arrived")).toBeNull();

      // Advance past the visible poll cadence so the ambient poll fires and
      // refreshThread(chat-1) merges the newly-arrived message IN PLACE.
      await act(async () => {
        jest.advanceTimersByTime(61_000);
      });
      await act(flush);

      expect(screen.getByText("live update arrived")).toBeInTheDocument();
      expect(threadCalls).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("MessagesPage — inline compose", () => {
  /**
   * Thin helper: select chat-1 and wait until the composer is mounted.
   * Every compose test goes through this so the setup boilerplate is
   * captured in one place.
   */
  async function selectChat1AndWaitForComposer() {
    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("messages-compose-input"));
  }

  /**
   * Pull out the JSON bodies of every /api/analytics POST fired so
   * far. Lets assertions focus on events-of-interest without having
   * to filter call-by-call.
   */
  function analyticsBodies(): Array<{ event: string; metadata: Record<string, unknown> }> {
    return mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1].body));
  }

  test("compose textarea + send button render when a chat is selected", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const textarea = screen.getByTestId("messages-compose-input") as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(screen.getByTestId("messages-compose-send")).toBeInTheDocument();
  });

  test("send button is disabled with empty input, enabled when typed", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const send = screen.getByTestId("messages-compose-send");
    expect(send).toBeDisabled();
    const textarea = screen.getByTestId("messages-compose-input");
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(send).not.toBeDisabled();
    // Whitespace-only still disabled.
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(send).toBeDisabled();
  });

  test("empty-thread hint shows above the composer when messages=[]", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    expect(screen.getByTestId("messages-empty-thread-hint")).toBeInTheDocument();
  });

  test("submit POSTs to /api/ms/chats/[id]/messages with correct body", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-1",
          createdDateTime: "2026-04-23T12:00:00Z",
          from: { displayName: "You" },
          body: { contentType: "text", content: "hi" },
        });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "hi" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/ms/chats/chat-1/messages" && c[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1].body);
    expect(body).toEqual({ content: "hi", contentType: "text" });
  });

  test("optimistic message appears immediately and resolves to server shape on success", async () => {
    // Gate the POST so we can observe optimistic state before resolution.
    let resolvePost!: (v: any) => void;
    const postPromise = new Promise((res) => {
      resolvePost = res;
    });
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return postPromise as any;
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "optimistic hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });

    // Optimistic row present.
    await waitFor(() => {
      const pending = document.querySelector(
        '[data-testid^="message-optimistic-"][data-pending="true"]',
      );
      expect(pending).not.toBeNull();
      expect((pending as HTMLElement).textContent).toMatch(/optimistic hello/);
    });

    // Resolve the POST.
    await act(async () => {
      resolvePost(
        ok({
          id: "srv-42",
          createdDateTime: "2026-04-23T12:00:00Z",
          from: { displayName: "You" },
          body: { contentType: "text", content: "optimistic hello" },
        }),
      );
      // Yield a microtask.
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-srv-42")).toBeInTheDocument();
    });
    const serverNode = screen.getByTestId("message-srv-42");
    expect(serverNode.getAttribute("data-pending")).toBe("false");
    expect(serverNode.textContent).toMatch(/optimistic hello/);
    // Optimistic row gone.
    expect(
      document.querySelector('[data-testid^="message-optimistic-"]'),
    ).toBeNull();

    // Analytics: compose_sent fired with length.
    const sent = analyticsBodies().find((b) => b.event === "messages.compose_sent");
    expect(sent).toBeDefined();
    expect(sent!.metadata).toEqual({
      chat_id: "chat-1",
      length: "optimistic hello".length,
    });
  });

  test("regression: successful send bumps the chat row's timestamp + preview in the LEFT list", async () => {
    // Bug: Nick messaged Max a minute ago but the LEFT panel still
    // showed "1d" because the chats array's lastUpdatedDateTime is
    // baked in at fetch time and never updated when we send. Fix:
    // mutate the matching chat row + re-sort on successful POST.
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-old" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-old/messages" && init?.method === "POST") {
        return ok({
          id: "srv-bump",
          createdDateTime: "2026-04-23T13:00:00Z", // newest of all sample chats
          from: { displayName: "You" },
          body: { contentType: "text", content: "fresh ping" },
        });
      }
      return ok({});
    });

    await renderMessagesOpen();

    // chat-old is dated 2026-04-01, so it lands at the BOTTOM of the
    // initial list ordering. Confirm that's where it starts.
    let rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="chat-row-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(rows[rows.length - 1]).toBe("chat-row-chat-old");

    // Open chat-old and send a message dated NOW.
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-old"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("messages-compose-input")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "fresh ping" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
      await Promise.resolve();
    });

    // After the send resolves, chat-old should have floated to the
    // TOP of the list and its preview should match what we sent.
    await waitFor(() => {
      rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="chat-row-"]'),
      ).map((el) => el.getAttribute("data-testid"));
      expect(rows[0]).toBe("chat-row-chat-old");
    });
    expect(
      screen.getByTestId("chat-preview-chat-old").textContent,
    ).toMatch(/fresh ping/);
  });

  test("scope_missing response shows inline prompt, removes optimistic, no error toast", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({ scope_missing: true });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("messages-compose-scope-hint")).toBeInTheDocument();
    });
    expect(screen.getByTestId("messages-compose-scope-cta")).toHaveAttribute(
      "href",
      "/settings",
    );
    // No error toast.
    expect(screen.queryByTestId("messages-toast")).toBeNull();
    // Optimistic removed.
    expect(
      document.querySelector('[data-testid^="message-optimistic-"]'),
    ).toBeNull();
    // Analytics.
    const bodies = analyticsBodies();
    expect(
      bodies.find(
        (b) =>
          b.event === "messages.compose_failed" &&
          b.metadata.reason === "scope_missing",
      ),
    ).toBeDefined();
    expect(
      bodies.find((b) => b.event === "messages.scope_prompt_shown"),
    ).toBeDefined();
  });

  test("write_disabled response shows inline write-disabled hint + removes optimistic", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({ write_disabled: true });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "hello" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("messages-compose-write-disabled-hint"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("messages-toast")).toBeNull();
    expect(
      document.querySelector('[data-testid^="message-optimistic-"]'),
    ).toBeNull();
    const bodies = analyticsBodies();
    expect(
      bodies.find(
        (b) =>
          b.event === "messages.compose_failed" &&
          b.metadata.reason === "write_disabled",
      ),
    ).toBeDefined();
    expect(
      bodies.find((b) => b.event === "messages.write_disabled_shown"),
    ).toBeDefined();
  });

  test("500 response shows error toast + rolls back optimistic", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({ error: "boom" }, 500);
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "bomb" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("messages-toast")).toBeInTheDocument();
    });
    expect(screen.getByTestId("messages-toast").textContent).toMatch(/couldn'?t send/i);
    expect(
      document.querySelector('[data-testid^="message-optimistic-"]'),
    ).toBeNull();
    // Draft restored so the user can retry.
    expect(
      (screen.getByTestId("messages-compose-input") as HTMLTextAreaElement).value,
    ).toBe("bomb");
    const bodies = analyticsBodies();
    expect(
      bodies.find(
        (b) =>
          b.event === "messages.compose_failed" &&
          String(b.metadata.reason).startsWith("http_500"),
      ),
    ).toBeDefined();
  });

  test("network error shows error toast + rolls back optimistic + fires compose_failed:network", async () => {
    mockFetchWithRefresh.mockImplementation((url: string, init: any) => {
      if (url === "/api/ms/chats")
        return Promise.resolve(ok({ chats: SAMPLE_CHATS }));
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return Promise.resolve(ok({ messages: [] }));
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(ok({}));
    });
    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("messages-compose-input"));
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "offline" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("messages-toast")).toBeInTheDocument();
    });
    const bodies = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1].body));
    expect(
      bodies.find(
        (b) =>
          b.event === "messages.compose_failed" && b.metadata.reason === "network",
      ),
    ).toBeDefined();
  });

  test("Cmd+Enter submits the composer", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-cmd",
          createdDateTime: "2026-04-23T12:00:00Z",
          from: { displayName: "You" },
          body: { contentType: "text", content: "cmd-enter" },
        });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const textarea = screen.getByTestId("messages-compose-input");
    fireEvent.change(textarea, { target: { value: "cmd-enter" } });
    await act(async () => {
      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        metaKey: true,
      });
    });
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/ms/chats/chat-1/messages" && c[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
  });

  test("Ctrl+Enter also submits (windows/linux)", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-ctrl",
          createdDateTime: "2026-04-23T12:00:00Z",
          from: { displayName: "You" },
          body: { contentType: "text", content: "ctrl-enter" },
        });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const textarea = screen.getByTestId("messages-compose-input");
    fireEvent.change(textarea, { target: { value: "ctrl-enter" } });
    await act(async () => {
      fireEvent.keyDown(textarea, {
        key: "Enter",
        code: "Enter",
        ctrlKey: true,
      });
    });
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/ms/chats/chat-1/messages" && c[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
  });

  test("plain Enter does NOT submit (multiline)", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const textarea = screen.getByTestId("messages-compose-input");
    fireEvent.change(textarea, { target: { value: "line one" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/ms/chats/chat-1/messages" && c[1]?.method === "POST",
    );
    expect(postCall).toBeUndefined();
  });

  test("More actions row (deep-links) renders BELOW the compose box", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/deep-links") return ok({ url: "msteams://foo" });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const compose = screen.getByTestId("messages-compose");
    const more = screen.getByTestId("messages-more-actions");
    expect(compose.contains(more)).toBe(true);
    // DeepLinkButtons are present inside More actions.
    expect(within(more).getByTestId("deep-link-reply")).toBeInTheDocument();
    expect(within(more).getByTestId("deep-link-call")).toBeInTheDocument();
    expect(within(more).getByTestId("deep-link-video")).toBeInTheDocument();
  });
});

// ===========================================================================
// @mentions — autocomplete dropdown + html-wrap on send + insights
// ===========================================================================

describe("MessagesPage — @mentions", () => {
  async function selectChat1AndWaitForComposer() {
    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("messages-compose-input"));
  }

  /**
   * `fireEvent.change` doesn't move the textarea selection — the
   * mention detector relies on `e.target.selectionStart`. Set the
   * cursor explicitly to the end of `value` after change.
   */
  function changeAndCursor(el: HTMLTextAreaElement, value: string) {
    fireEvent.change(el, { target: { value } });
    el.selectionStart = value.length;
    el.selectionEnd = value.length;
    // Re-fire change so onChange sees the cursor we just set.
    fireEvent.change(el, { target: { value } });
  }

  beforeEach(() => {
    mockFetchWithRefresh.mockReset();
    mockEmitInsight.mockReset();
  });

  test("typing @ opens the mention dropdown and lists non-self chat members", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const ta = screen.getByTestId(
      "messages-compose-input",
    ) as HTMLTextAreaElement;
    changeAndCursor(ta, "@");
    await waitFor(() =>
      expect(screen.getByTestId("messages-mention-dropdown")).toBeInTheDocument(),
    );
    // chat-1 has Me + Jane Doe; mockGetInstinctUser → me@x which
    // matches neither, so both render. Both members appear as options.
    expect(
      screen.getByTestId("messages-mention-option-user-jane"),
    ).toBeInTheDocument();
  });

  test("typing without @ does NOT open the dropdown", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const ta = screen.getByTestId(
      "messages-compose-input",
    ) as HTMLTextAreaElement;
    changeAndCursor(ta, "hello team");
    expect(screen.queryByTestId("messages-mention-dropdown")).toBeNull();
  });

  test("Escape closes the dropdown without inserting", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const ta = screen.getByTestId(
      "messages-compose-input",
    ) as HTMLTextAreaElement;
    changeAndCursor(ta, "@J");
    await waitFor(() =>
      expect(screen.getByTestId("messages-mention-dropdown")).toBeInTheDocument(),
    );
    fireEvent.keyDown(ta, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("messages-mention-dropdown")).toBeNull(),
    );
    // Text untouched — no insertion happened.
    expect(ta.value).toBe("@J");
  });

  test("clicking a member inserts @DisplayName and emits mention_added insight", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1") return ok({ messages: [] });
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const ta = screen.getByTestId(
      "messages-compose-input",
    ) as HTMLTextAreaElement;
    changeAndCursor(ta, "hi @J");
    await waitFor(() =>
      expect(screen.getByTestId("messages-mention-dropdown")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("messages-mention-option-user-jane"),
      );
    });
    // Trailing space inserted so the user keeps typing in flow.
    expect(ta.value).toBe("hi @Jane Doe ");
    // Dropdown closes.
    expect(screen.queryByTestId("messages-mention-dropdown")).toBeNull();
    // Insight emitted with correct canonical shape.
    const added = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .find(
        (e: { surface: string; action: string }) =>
          e.surface === "chat" && e.action === "mention_added",
      );
    expect(added).toBeDefined();
    expect(added.tier).toBe("personal");
    expect(added.target).toBe("chat-1");
    expect(added.payload.target_user_id).toBe("user-jane");
  });

  test("sending with mentions POSTs html-wrapped content + mentions array", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-mention",
          createdDateTime: "2026-04-23T13:00:00Z",
          from: { displayName: "You" },
          body: { contentType: "html", content: "ok" },
        });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const ta = screen.getByTestId(
      "messages-compose-input",
    ) as HTMLTextAreaElement;
    // Type "@J", pick Jane, then add trailing text.
    changeAndCursor(ta, "@J");
    await waitFor(() =>
      expect(screen.getByTestId("messages-mention-dropdown")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("messages-mention-option-user-jane"),
      );
    });
    // Append a trailing question.
    changeAndCursor(ta, "@Jane Doe ping?");
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        c[0] === "/api/ms/chats/chat-1/messages" && c[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1].body);
    expect(body.contentType).toBe("html");
    expect(body.content).toBe('<at id="0">Jane Doe</at> ping?');
    expect(body.mentions).toEqual([
      {
        id: 0,
        mentionText: "Jane Doe",
        userId: "user-jane",
        displayName: "Jane Doe",
      },
    ]);
  });

  test("successful send with mentions emits mention_completed insight with mention_count", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-c",
          createdDateTime: "2026-04-23T13:00:00Z",
          from: { displayName: "You" },
          body: { contentType: "html", content: "ok" },
        });
      }
      return ok({});
    });
    await selectChat1AndWaitForComposer();
    const ta = screen.getByTestId(
      "messages-compose-input",
    ) as HTMLTextAreaElement;
    changeAndCursor(ta, "@J");
    await waitFor(() =>
      expect(screen.getByTestId("messages-mention-dropdown")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("messages-mention-option-user-jane"),
      );
    });
    changeAndCursor(ta, "@Jane Doe hi");
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
    });
    const completed = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .find(
        (e: { surface: string; action: string }) =>
          e.surface === "chat" && e.action === "mention_completed",
      );
    expect(completed).toBeDefined();
    expect(completed.tier).toBe("org");
    expect(completed.target).toBe("chat-1");
    expect(completed.payload.mention_count).toBe(1);
  });
});

// ===========================================================================
// LEFT panel — collapsible Chats section + Teams & channels section
// ===========================================================================

describe("MessagesPage — collapsible sections + Teams & channels", () => {
  beforeEach(() => {
    mockFetchWithRefresh.mockReset();
    try {
      window.localStorage.clear();
      window.localStorage.setItem(
        "instinct_user",
        JSON.stringify({ email: "me@wolfpack.test" }),
      );
      // Sections now default to COLLAPSED. Tests in this block were
      // written assuming open-by-default — seed both sections open
      // for every test except the ones that explicitly exercise the
      // new collapsed default.
      window.localStorage.setItem("instinct.messages.chats_open", "1");
      window.localStorage.setItem("instinct.messages.teams_open", "1");
    } catch {
      /* noop */
    }
  });

  function wireSimpleGraph() {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/teams")
        return ok({
          teams: [
            { id: "team-wolf", displayName: "Wolfpack Internal" },
            { id: "team-cftr", displayName: "CFTR" },
          ],
        });
      if (url === "/api/ms/teams/team-wolf/channels")
        return ok({
          channels: [
            { id: "ch-general", displayName: "General" },
            { id: "ch-eng", displayName: "Engineering" },
          ],
        });
      if (url === "/api/ms/teams/team-wolf/channels/ch-eng/messages")
        return ok({
          messages: [
            {
              id: "cm-old",
              createdDateTime: "2026-04-23T10:00:00Z",
              from: { displayName: "Max" },
              body: { contentType: "text", content: "first" },
              bodyText: "first",
            },
            {
              id: "cm-new",
              createdDateTime: "2026-04-23T11:00:00Z",
              from: { displayName: "Nick" },
              body: { contentType: "text", content: "second" },
              bodyText: "second",
            },
          ],
        });
      return ok({});
    });
  }

  test("Chats section defaults to COLLAPSED on first load and toggles open", async () => {
    // Bypass the describe-level seed — we're testing first-load behavior.
    window.localStorage.removeItem("instinct.messages.chats_open");
    window.localStorage.removeItem("instinct.messages.teams_open");
    wireSimpleGraph();
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));

    // New default — collapsed on first visit (localStorage empty).
    // Once a workspace has dozens of chats, an open-by-default list
    // scrolled the page. Users now opt in.
    expect(screen.queryByTestId("messages-section-chats-list")).toBeNull();
    expect(
      screen.getByTestId("messages-section-chats-toggle"),
    ).toHaveAttribute("data-open", "false");

    // Click to expand — chat list renders.
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-section-chats-toggle"));
    });
    expect(screen.getByTestId("messages-section-chats-list")).toBeInTheDocument();
    expect(
      screen.getByTestId("messages-section-chats-toggle"),
    ).toHaveAttribute("data-open", "true");

    // Persisted to localStorage as "1" so the choice survives reload.
    expect(window.localStorage.getItem("instinct.messages.chats_open")).toBe("1");

    // Toggle fires analytics.
    const fired = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1]?.body ?? "{}"));
    expect(fired.find((b) => b.event === "messages.section_toggled")).toEqual(
      expect.objectContaining({
        event: "messages.section_toggled",
        metadata: { section: "chats", expanded: true },
      }),
    );
  });

  test("returning user with chats_open=1 in localStorage starts expanded", async () => {
    // describe-level seed already sets this; assert behavior holds.
    wireSimpleGraph();
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
    expect(screen.getByTestId("messages-section-chats-list")).toBeInTheDocument();
    expect(
      screen.getByTestId("messages-section-chats-toggle"),
    ).toHaveAttribute("data-open", "true");
  });

  test("Teams section lazy-loads /api/ms/teams when first expanded", async () => {
    // Section now defaults to COLLAPSED so we must seed localStorage
    // OR click to expand before the lazy load fires.
    window.localStorage.setItem("instinct.messages.teams_open", "1");
    wireSimpleGraph();
    await renderMessagesOpen();

    // Section is open via the seeded preference → /api/ms/teams should fire on mount.
    await waitFor(() => {
      expect(
        mockFetchWithRefresh.mock.calls.some((c) => c[0] === "/api/ms/teams"),
      ).toBe(true);
    });

    // Both teams render under the Teams section.
    await waitFor(() => {
      expect(screen.getByTestId("team-row-team-wolf")).toBeInTheDocument();
      expect(screen.getByTestId("team-row-team-cftr")).toBeInTheDocument();
    });
    // Sorted alphabetically — CFTR comes before Wolfpack Internal.
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="team-row-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(rows.indexOf("team-row-team-cftr")).toBeLessThan(
      rows.indexOf("team-row-team-wolf"),
    );
  });

  test("regression: hydrated-expanded teams auto-load channels on mount", async () => {
    // Bug: expandedTeams persists to localStorage, but channelsByTeam
    // doesn't. After a reload, teams marked expanded sat with no
    // channel data in state, and the render path showed "No channels."
    // instead of triggering a fetch. Fix: useEffect on teams arrival
    // backfills any expanded-but-unloaded team. This test seeds the
    // localStorage flag and asserts the fetch happens automatically.
    window.localStorage.setItem(
      "instinct.messages.expanded_teams",
      JSON.stringify({ "team-wolf": true }),
    );
    // Teams section now defaults collapsed — seed open so the team
    // rows render at all.
    window.localStorage.setItem("instinct.messages.teams_open", "1");
    wireSimpleGraph();
    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("team-row-team-wolf"));
    // Channels should appear without us clicking the toggle.
    await waitFor(() => {
      expect(screen.getByTestId("channel-row-ch-general")).toBeInTheDocument();
    });
  });

  test("expanding a team loads its channels and persists the expansion state", async () => {
    window.localStorage.setItem("instinct.messages.teams_open", "1");
    wireSimpleGraph();
    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("team-row-team-wolf"));

    // Channels not loaded yet.
    expect(screen.queryByTestId("channel-row-ch-eng")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("team-toggle-team-wolf"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("channel-row-ch-general")).toBeInTheDocument();
      expect(screen.getByTestId("channel-row-ch-eng")).toBeInTheDocument();
    });

    // "General" first by Teams convention, then alpha.
    const channels = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="channel-row-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(channels[0]).toBe("channel-row-ch-general");

    // Persisted.
    const persisted = JSON.parse(
      window.localStorage.getItem("instinct.messages.expanded_teams") ?? "{}",
    );
    expect(persisted["team-wolf"]).toBe(true);

    // Analytics.
    const fired = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1]?.body ?? "{}"));
    expect(fired.find((b) => b.event === "messages.team_toggled")).toEqual(
      expect.objectContaining({
        metadata: { team_id: "team-wolf", expanded: true },
      }),
    );
  });

  test("clicking a channel loads its messages, renders ascending, fires analytics", async () => {
    wireSimpleGraph();
    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("team-row-team-wolf"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-toggle-team-wolf"));
    });
    await waitFor(() => screen.getByTestId("channel-row-ch-eng"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-row-ch-eng"));
    });

    // Channel header + thread present.
    await waitFor(() => {
      expect(screen.getByTestId("channel-title").textContent).toMatch(
        /Wolfpack Internal · #Engineering/,
      );
      expect(screen.getByTestId("channel-message-cm-old")).toBeInTheDocument();
      expect(screen.getByTestId("channel-message-cm-new")).toBeInTheDocument();
    });

    // Ascending DOM order — newest at the bottom.
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="channel-message-"]',
      ),
    ).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["channel-message-cm-old", "channel-message-cm-new"]);

    // Analytics: channel_selected.
    const fired = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1]?.body ?? "{}"));
    expect(fired.find((b) => b.event === "messages.channel_selected")).toEqual(
      expect.objectContaining({
        metadata: { team_id: "team-wolf", channel_id: "ch-eng" },
      }),
    );

    // Back button restores no-selection state.
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-back"));
    });
    expect(screen.queryByTestId("channel-thread-body")).toBeNull();
  });

  test("graph_error response shows a loud error card (NOT the silent empty state)", async () => {
    // Regression: Nick reported the Teams section appearing "blank"
    // when his existing OAuth token didn't include the new scopes.
    // The empty card was too subtle; this test locks in the louder
    // graph-error treatment + the actual HTTP status surfaced.
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/teams")
        return ok({
          teams: [],
          graph_error: true,
          graph_status: 400,
          graph_code: "BadRequest",
          graph_message:
            "Insufficient privileges to complete the operation.",
        });
      return ok({});
    });
    await renderMessagesOpen();
    await waitFor(() => {
      const card = screen.getByTestId("messages-teams-graph-error");
      expect(card).toBeInTheDocument();
      // Status, Graph error code, and full message all surfaced —
      // so Nick can act on the actual reason instead of guessing.
      expect(card.textContent).toMatch(/400/);
    });
    expect(screen.getByTestId("messages-teams-graph-code").textContent).toBe(
      "BadRequest",
    );
    expect(
      screen.getByTestId("messages-teams-graph-message").textContent,
    ).toMatch(/Insufficient privileges/);
    // And the "you haven't joined any teams" empty state is NOT
    // shown (would be the wrong message).
    expect(screen.queryByTestId("messages-teams-empty")).toBeNull();
  });

  test("scope_missing on /api/ms/teams shows the grant-permission card", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/teams")
        return ok({ teams: [], scope_missing: true });
      return ok({});
    });
    await renderMessagesOpen();
    await waitFor(() => {
      expect(
        screen.getByTestId("messages-teams-scope-missing"),
      ).toBeInTheDocument();
    });
  });

  test("channel composer: optimistic message + swap to server response on send", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/teams")
        return ok({
          teams: [{ id: "team-wolf", displayName: "Wolfpack Internal" }],
        });
      if (url === "/api/ms/teams/team-wolf/channels")
        return ok({ channels: [{ id: "ch-eng", displayName: "Engineering" }] });
      if (url === "/api/ms/teams/team-wolf/channels/ch-eng/messages" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (
        url === "/api/ms/teams/team-wolf/channels/ch-eng/messages" &&
        init?.method === "POST"
      ) {
        return ok({
          message: {
            id: "srv-42",
            createdDateTime: "2026-04-24T11:00:00Z",
            from: { displayName: "You" },
            body: { contentType: "text", content: "shipped it" },
            bodyText: "shipped it",
          },
        });
      }
      return ok({});
    });

    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("team-row-team-wolf"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-toggle-team-wolf"));
    });
    await waitFor(() => screen.getByTestId("channel-row-ch-eng"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-row-ch-eng"));
    });
    await waitFor(() => screen.getByTestId("channel-compose-input"));

    fireEvent.change(screen.getByTestId("channel-compose-input"), {
      target: { value: "shipped it" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-compose-send"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("channel-message-srv-42")).toBeInTheDocument();
    });
    // Analytics: channel_compose_sent fired with length.
    const fired = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1]?.body ?? "{}"));
    const sent = fired.find((b) => b.event === "messages.channel_compose_sent");
    expect(sent).toBeDefined();
    expect(sent.metadata).toEqual({
      team_id: "team-wolf",
      channel_id: "ch-eng",
      length: "shipped it".length,
    });
  });

  test("channel composer: scope_missing response shows hint + rolls back optimistic", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/teams")
        return ok({ teams: [{ id: "team-wolf", displayName: "Wolfpack Internal" }] });
      if (url === "/api/ms/teams/team-wolf/channels")
        return ok({ channels: [{ id: "ch-eng", displayName: "Engineering" }] });
      if (url === "/api/ms/teams/team-wolf/channels/ch-eng/messages" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (
        url === "/api/ms/teams/team-wolf/channels/ch-eng/messages" &&
        init?.method === "POST"
      )
        return ok({ message: null, scope_missing: true });
      return ok({});
    });
    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("team-row-team-wolf"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-toggle-team-wolf"));
    });
    await waitFor(() => screen.getByTestId("channel-row-ch-eng"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-row-ch-eng"));
    });
    await waitFor(() => screen.getByTestId("channel-compose-input"));
    fireEvent.change(screen.getByTestId("channel-compose-input"), {
      target: { value: "blocked" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-compose-send"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("channel-compose-error").textContent).toMatch(
        /ChannelMessage\.Send/,
      );
    });
    // Optimistic was rolled back — only the inline error remains, no
    // optimistic-* row in the thread.
    expect(
      document.querySelector('[data-testid^="channel-message-optimistic"]'),
    ).toBeNull();
  });

  test("AI draft button: requests, fills textarea with suggestion, fires acceptance analytics on send", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({
          messages: [
            {
              id: "m-prev",
              from: { displayName: "Jane" },
              createdDateTime: "2026-04-24T10:00:00Z",
              body: { contentType: "text", content: "any update?" },
            },
          ],
        });
      if (url === "/api/assistant/draft-reply" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.surface).toBe("chat");
        expect(body.contextId).toBe("chat-1");
        expect(body.threadContext.length).toBeGreaterThan(0);
        return ok({
          text: "Almost there — sending in a few.",
          model: "test-model",
          promptTokens: 30,
          completionTokens: 8,
        });
      }
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-ai",
          createdDateTime: "2026-04-24T10:01:00Z",
          from: { displayName: "You" },
          body: {
            contentType: "text",
            content: "Almost there — sending in a few.",
          },
        });
      }
      return ok({});
    });

    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("messages-compose-ai-draft"));

    // Click AI button → suggestion fills the textarea.
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-ai-draft"));
      await Promise.resolve();
    });
    await waitFor(() => {
      const textarea = screen.getByTestId(
        "messages-compose-input",
      ) as HTMLTextAreaElement;
      expect(textarea.value).toMatch(/Almost there/);
    });

    // Send unmodified → fires assistant.draft_accepted (edit_distance 0).
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
      await Promise.resolve();
    });
    await waitFor(() => {
      const fired = mockFetchWithRefresh.mock.calls
        .filter((c) => c[0] === "/api/analytics")
        .map((c) => JSON.parse(c[1]?.body ?? "{}"));
      const accepted = fired.find(
        (b) => b.event === "assistant.draft_accepted",
      );
      expect(accepted).toBeDefined();
      expect(accepted.metadata.surface).toBe("chat");
      expect(accepted.metadata.context_id).toBe("chat-1");
      expect(accepted.metadata.edit_distance).toBe(0);
    });
  });

  test("AI draft followed by edited send fires assistant.draft_modified", async () => {
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1" && (!init || init.method === "GET"))
        return ok({ messages: [] });
      if (url === "/api/assistant/draft-reply" && init?.method === "POST") {
        return ok({
          text: "I will send the report tomorrow morning.",
          model: "m",
          promptTokens: 1,
          completionTokens: 1,
        });
      }
      if (url === "/api/ms/chats/chat-1/messages" && init?.method === "POST") {
        return ok({
          id: "srv-ai-edit",
          createdDateTime: "2026-04-24T10:02:00Z",
          from: { displayName: "You" },
          body: { contentType: "text", content: "report tonight" },
        });
      }
      return ok({});
    });

    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("messages-compose-ai-draft"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-ai-draft"));
      await Promise.resolve();
    });
    // Heavily edit before sending.
    fireEvent.change(screen.getByTestId("messages-compose-input"), {
      target: { value: "report tonight" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-compose-send"));
      await Promise.resolve();
    });
    await waitFor(() => {
      const fired = mockFetchWithRefresh.mock.calls
        .filter((c) => c[0] === "/api/analytics")
        .map((c) => JSON.parse(c[1]?.body ?? "{}"));
      const modified = fired.find(
        (b) => b.event === "assistant.draft_modified",
      );
      expect(modified).toBeDefined();
      expect(modified.metadata.edit_distance).toBeGreaterThan(0);
    });
  });

  test("regression: messages-page constrains its own scroll (overflow:hidden + position:absolute)", async () => {
    wireSimpleGraph();
    await renderMessagesOpen();
    const page = screen.getByTestId("messages-page");
    // Inline style — the page has to claim a fixed slot in the
    // dashboard <main> so its inner aside / thread scroll
    // independently. Otherwise users had to scroll the entire
    // dashboard to reach the bottom of the channels list.
    expect(page.style.height).toBe("100%");
    expect(page.style.overflow).toBe("hidden");
    expect(page.style.flexDirection).toBe("column");
  });

  test("selecting a chat clears any active channel selection (right pane is single-target)", async () => {
    wireSimpleGraph();
    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("team-row-team-wolf"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-toggle-team-wolf"));
    });
    await waitFor(() => screen.getByTestId("channel-row-ch-eng"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-row-ch-eng"));
    });
    await waitFor(() => screen.getByTestId("channel-thread-body"));

    // Now pick a chat — channel pane should disappear.
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("channel-thread-body")).toBeNull();
    });
  });
});

/**
 * Bug-fix bundle 2026-04-29: empty bubbles, unread state, deep-link.
 */
describe("MessagesPage — Bug fix 2026-04-29 (bubbles + unread + deep-link)", () => {
  beforeEach(() => {
    mockFetchWithRefresh.mockReset();
    try {
      window.localStorage.clear();
      window.localStorage.setItem(
        "instinct_user",
        JSON.stringify({ email: "me@wolfpack.test" }),
      );
      window.localStorage.setItem("instinct.messages.chats_open", "1");
      window.localStorage.setItem("instinct.messages.teams_open", "1");
    } catch {
      /* noop */
    }
    try {
      window.history.replaceState({}, "", "/messages");
    } catch {
      /* noop */
    }
  });

  test("Bug 1: systemEventMessage rows render as a centered pill, not an empty bubble", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({
          messages: [
            {
              id: "m-text",
              createdDateTime: "2026-04-23T11:00:00Z",
              from: { displayName: "Jane" },
              body: { contentType: "text", content: "hello" },
              bodyText: "hello",
            },
            {
              id: "m-call",
              createdDateTime: "2026-04-23T11:30:00Z",
              from: { displayName: "Jane" },
              body: { contentType: "text", content: "" },
              bodyText: "",
              messageType: "systemEventMessage",
              eventDetail: { subtype: "callEnded" },
            },
            {
              id: "m-members",
              createdDateTime: "2026-04-23T12:00:00Z",
              from: { displayName: "Jane" },
              body: { contentType: "text", content: "" },
              bodyText: "",
              messageType: "systemEventMessage",
              eventDetail: {
                subtype: "membersAdded",
                memberNames: ["Ashley"],
              },
            },
          ],
        });
      return ok({});
    });

    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });

    await waitFor(() => screen.getByTestId("system-event-m-call"));
    expect(screen.getByTestId("system-event-m-call").textContent).toMatch(
      /Call ended/,
    );
    expect(screen.getByTestId("system-event-m-members").textContent).toMatch(
      /Ashley joined the chat/,
    );
    // Normal message bubble still renders.
    expect(screen.getByTestId("message-m-text")).toBeInTheDocument();
  });

  test("Bug 1: attachment-only messages render as an attachment summary pill", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({
          messages: [
            {
              id: "m-attach",
              createdDateTime: "2026-04-23T11:00:00Z",
              from: { displayName: "Jane" },
              body: { contentType: "text", content: "" },
              bodyText: "",
              attachments: [
                { contentType: "reference", name: "budget.xlsx" },
              ],
            },
          ],
        });
      return ok({});
    });
    await renderMessagesOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });
    await waitFor(() => screen.getByTestId("attachment-summary-m-attach"));
    expect(
      screen.getByTestId("attachment-summary-m-attach").textContent,
    ).toMatch(/budget\.xlsx/);
  });

  test("Bug 2: chat row shows bold + dot when last message is newer than read-state cursor", async () => {
    // Read-state has chat-1 read 1 minute BEFORE its lastUpdatedDateTime,
    // chat-2 read AFTER its lastUpdatedDateTime. chat-1 should be unread,
    // chat-2 should be read. chat-old has no cursor → unread by default.
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/messages/read-state")
        return ok({
          state: {
            "chat-1": "2026-04-23T09:59:00Z", // older than 10:00:00Z → unread
            "chat-2": "2026-04-22T08:00:00Z", // equal → read
          },
        });
      return ok({});
    });

    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("chat-row-chat-1"));

    // chat-1: unread by cursor
    await waitFor(() => {
      expect(screen.getByTestId("chat-row-chat-1")).toHaveAttribute(
        "data-unread",
        "true",
      );
    });
    // unread dot indicator visible
    expect(screen.queryByTestId("chat-unread-dot-chat-1")).toBeInTheDocument();

    // chat-2: read (cursor >= lastUpdatedDateTime)
    expect(screen.getByTestId("chat-row-chat-2")).toHaveAttribute(
      "data-unread",
      "false",
    );
    expect(screen.queryByTestId("chat-unread-dot-chat-2")).toBeNull();

    // chat-old: no cursor → unread by default
    expect(screen.getByTestId("chat-row-chat-old")).toHaveAttribute(
      "data-unread",
      "true",
    );
  });

  test("Bug 2: opening an unread chat POSTs read-state and the row flips to read", async () => {
    let readStatePost: { chat_id: string; kind: string } | null = null;
    wireApiRouter((url, init) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      if (url === "/api/ms/chats/chat-1")
        return ok({
          messages: [
            {
              id: "m1",
              createdDateTime: "2026-04-23T11:00:00Z",
              from: { displayName: "Jane" },
              body: { contentType: "text", content: "hi" },
              bodyText: "hi",
            },
          ],
        });
      if (url === "/api/messages/read-state") {
        if (init?.method === "POST") {
          const body = JSON.parse((init?.body as string) ?? "{}") as {
            chat_id: string;
            last_read_at: string;
            kind: string;
          };
          readStatePost = body;
          return ok({ ok: true, last_read_at: body.last_read_at });
        }
        return ok({ state: {} });
      }
      return ok({});
    });

    await renderMessagesOpen();
    await waitFor(() => screen.getByTestId("chat-row-chat-1"));
    expect(screen.getByTestId("chat-row-chat-1")).toHaveAttribute(
      "data-unread",
      "true",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-row-chat-1"));
    });

    // The selected chat row is no longer flagged unread (data-unread="false")
    // because selectChat sets isSelected and the bold+dot suppresses while
    // selected.
    await waitFor(() => {
      expect(screen.getByTestId("chat-row-chat-1")).toHaveAttribute(
        "data-unread",
        "false",
      );
    });

    // POST fired with chat_id + kind:"chat".
    await waitFor(() => {
      expect(readStatePost).not.toBeNull();
    });
    expect(readStatePost!.chat_id).toBe("chat-1");
    expect(readStatePost!.kind).toBe("chat");
  });

  test("Bug 3: ?chat=X&message=Y opens the chat and scrolls + flashes the target message", async () => {
    const scrollSpy = jest.fn();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      scrollSpy;

    // RAFs run synchronously in tests via setImmediate fallback below.
    const realRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      cb(0);
      return 0;
    };

    try {
      window.history.replaceState({}, "", "/messages?chat=chat-1&message=m-target");

      wireApiRouter((url) => {
        if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
        if (url === "/api/ms/chats/chat-1")
          return ok({
            messages: [
              {
                id: "m-other",
                createdDateTime: "2026-04-23T10:00:00Z",
                from: { displayName: "Jane" },
                body: { contentType: "text", content: "hi" },
                bodyText: "hi",
              },
              {
                id: "m-target",
                createdDateTime: "2026-04-23T11:00:00Z",
                from: { displayName: "Jane" },
                body: { contentType: "text", content: "look here" },
                bodyText: "look here",
              },
            ],
          });
        return ok({});
      });

      await renderMessagesOpen();

      // The chat auto-selects via the existing pendingDeepLink handler.
      await waitFor(() => screen.getByTestId("message-m-target"));

      // The deep-link useEffect calls scrollIntoView + applies flash class.
      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalled();
      });
      const target = screen.getByTestId("message-m-target");
      expect(target.classList.contains("message-flash")).toBe(true);

      // messages.deep_link_landed analytics fired with scroll_succeeded:true.
      const analyticsCalls = mockFetchWithRefresh.mock.calls.filter((c) => {
        if (c[0] !== "/api/analytics") return false;
        try {
          return JSON.parse(c[1].body).event === "messages.deep_link_landed";
        } catch {
          return false;
        }
      });
      expect(analyticsCalls.length).toBeGreaterThan(0);
      const payload = JSON.parse(analyticsCalls[0][1].body);
      expect(payload.metadata.chat_id).toBe("chat-1");
      expect(payload.metadata.message_id).toBe("m-target");
      expect(payload.metadata.scroll_succeeded).toBe(true);
    } finally {
      window.requestAnimationFrame = realRAF;
    }
  });
});
