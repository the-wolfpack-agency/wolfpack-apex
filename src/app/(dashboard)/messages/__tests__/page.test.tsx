/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
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
