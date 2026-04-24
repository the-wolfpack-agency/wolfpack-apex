/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
  } catch {
    /* noop */
  }
});

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

// ---------------------------------------------------------------- page

describe("MessagesPage", () => {
  test("renders list sorted by lastUpdatedDateTime desc", async () => {
    wireApiRouter((url) => {
      if (url === "/api/ms/chats") return ok({ chats: SAMPLE_CHATS });
      return ok({});
    });
    render(<MessagesPage />);
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
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
    expect(screen.getByTestId("chat-unread-chat-1")).toHaveTextContent("2");
    const row2 = screen.getByTestId("chat-row-chat-2");
    expect(within(row2).getByText("Launch team")).toBeInTheDocument();
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

    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));

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

    render(<MessagesPage />);
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

    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
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
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
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

    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
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
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("chat-row-chat-1"));
    const row = screen.getByTestId("chat-row-chat-1") as HTMLElement;
    const inline = row.getAttribute("style") ?? "";
    expect(inline).toMatch(/color:\s*var\(--wp-text/);
    expect(inline).not.toMatch(/background:\s*#fff/i);
  });
});

// ---------------------------------------------------------------- compose

describe("MessagesPage — inline compose", () => {
  /**
   * Thin helper: select chat-1 and wait until the composer is mounted.
   * Every compose test goes through this so the setup boilerplate is
   * captured in one place.
   */
  async function selectChat1AndWaitForComposer() {
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
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

    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));

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
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
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

  test("Chats section header is present and toggles the chat list visibility", async () => {
    wireSimpleGraph();
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));

    // Chats section is visible by default.
    expect(screen.getByTestId("messages-section-chats-list")).toBeInTheDocument();
    expect(
      screen.getByTestId("messages-section-chats-toggle"),
    ).toHaveAttribute("data-open", "true");

    // Click to collapse — chat list disappears.
    await act(async () => {
      fireEvent.click(screen.getByTestId("messages-section-chats-toggle"));
    });
    expect(screen.queryByTestId("messages-section-chats-list")).toBeNull();
    expect(
      screen.getByTestId("messages-section-chats-toggle"),
    ).toHaveAttribute("data-open", "false");

    // Persisted to localStorage.
    expect(window.localStorage.getItem("instinct.messages.chats_open")).toBe("0");

    // Toggle fires analytics.
    const fired = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1]?.body ?? "{}"));
    expect(fired.find((b) => b.event === "messages.section_toggled")).toEqual(
      expect.objectContaining({
        event: "messages.section_toggled",
        metadata: { section: "chats", expanded: false },
      }),
    );
  });

  test("Teams section lazy-loads /api/ms/teams when first expanded", async () => {
    wireSimpleGraph();
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));

    // Section is open by default → /api/ms/teams should fire on mount.
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

  test("expanding a team loads its channels and persists the expansion state", async () => {
    wireSimpleGraph();
    render(<MessagesPage />);
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
    render(<MessagesPage />);
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
        return ok({ teams: [], graph_error: true, graph_status: 400 });
      return ok({});
    });
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
    await waitFor(() => {
      const card = screen.getByTestId("messages-teams-graph-error");
      expect(card).toBeInTheDocument();
      // The actual HTTP status is shown so Nick (or whoever debugs)
      // can see what Graph said.
      expect(card.textContent).toMatch(/400/);
    });
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
    render(<MessagesPage />);
    await waitFor(() => screen.getByTestId("messages-page"));
    await waitFor(() => {
      expect(
        screen.getByTestId("messages-teams-scope-missing"),
      ).toBeInTheDocument();
    });
  });

  test("selecting a chat clears any active channel selection (right pane is single-target)", async () => {
    wireSimpleGraph();
    render(<MessagesPage />);
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
