/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

const mockEmitInsight = jest.fn();
jest.mock("@/lib/insights/emit", () => ({
  emitInsight: (e: unknown) => mockEmitInsight(e),
}));

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import InboxPanel from "@/app/(dashboard)/emails/InboxPanel";

function ok(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const SAMPLE_INBOX = {
  messages: [
    {
      id: "m1",
      subject: "Onboarding deck",
      from: { name: "Jane Doe", email: "jane@example.com" },
      receivedDateTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      bodyPreview: "Looks great — let's review tomorrow.",
      isRead: false,
      hasAttachments: false,
      importance: "normal",
      webLink: "https://outlook.office.com/m/m1",
    },
    {
      id: "m2",
      subject: "Quick question",
      from: { name: "Bob", email: "bob@example.com" },
      receivedDateTime: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      bodyPreview: "Got a sec to chat?",
      isRead: true,
      hasAttachments: false,
      importance: "normal",
      webLink: "",
    },
  ],
  nextSkip: null,
  unreadCount: 1,
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockEmitInsight.mockReset();
  mockFetchWithRefresh.mockImplementation(() => Promise.resolve(ok(SAMPLE_INBOX)));
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("InboxPanel", () => {
  it("renders inbox rows with subject and sender", async () => {
    const onOpen = jest.fn();
    const onCompose = jest.fn();
    render(
      <InboxPanel
        activeId={null}
        onOpen={onOpen}
        onCompose={onCompose}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    await waitFor(() => {
      expect(screen.getByText("Onboarding deck")).toBeInTheDocument();
    });
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("Quick question")).toBeInTheDocument();
  });

  it("shows the unread dot only for unread rows", async () => {
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    await waitFor(() => screen.getByTestId("inbox-row-m1"));
    expect(screen.getByTestId("inbox-row-dot-m1")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-row-dot-m2")).not.toBeInTheDocument();
  });

  it("emits insight.email.inbox_opened on first load with counts", async () => {
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    await waitFor(() => {
      const opened = mockEmitInsight.mock.calls
        .map((c) => c[0])
        .find((e: any) => e.action === "inbox_opened");
      expect(opened).toBeTruthy();
      expect(opened.payload.unread_count).toBe(1);
      expect(opened.payload.total_count).toBe(2);
    });
  });

  it("clicking a row calls onOpen and emits thread_read", async () => {
    const onOpen = jest.fn();
    render(
      <InboxPanel
        activeId={null}
        onOpen={onOpen}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    await waitFor(() => screen.getByTestId("inbox-row-m1"));
    fireEvent.click(screen.getByTestId("inbox-row-m1"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
    const evt = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.action === "thread_read");
    expect(evt).toBeTruthy();
    expect(evt.payload.thread_id).toBe("m1");
  });

  it("clicking 'New email' triggers onCompose and emits compose_drawer_opened", async () => {
    const onCompose = jest.fn();
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={onCompose}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    fireEvent.click(screen.getByTestId("inbox-new-email"));
    expect(onCompose).toHaveBeenCalled();
    const evt = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.action === "compose_drawer_opened");
    expect(evt).toBeTruthy();
    expect(evt.payload.source).toBe("inbox_button");
  });

  it("filters to unread when toggle clicked, refetches with unread=true", async () => {
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    fireEvent.click(screen.getByTestId("inbox-filter-unread"));
    await flush();
    await waitFor(() => {
      const callsWithUnread = mockFetchWithRefresh.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("unread=true"),
      );
      expect(callsWithUnread.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders the not_connected error state with a Settings link", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(ok({ error: "microsoft_not_connected" }, 401)),
    );
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    await waitFor(() => {
      const err = screen.getByTestId("inbox-error");
      expect(err.getAttribute("data-code")).toBe("not_connected");
    });
    expect(screen.getByText(/Open Settings/i)).toBeInTheDocument();
  });

  it("renders scope_missing error with the scope name", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(ok({ error: "forbidden", code: "scope_missing", scope: "Mail.Read" }, 403)),
    );
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    await waitFor(() => {
      const err = screen.getByTestId("inbox-error");
      expect(err.getAttribute("data-code")).toBe("scope_missing");
    });
    expect(screen.getByText(/Mail\.Read/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Folder-aware behaviour (Drafts / Sent / Archived)
// ---------------------------------------------------------------------------

describe("InboxPanel — folder awareness", () => {
  it("default folder is 'inbox' and the request URL carries folder=inbox", async () => {
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
      />,
    );
    await flush();
    const urls = mockFetchWithRefresh.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u.includes("folder=inbox"))).toBe(true);
    expect(screen.getByTestId("inbox-header-label")).toHaveTextContent("Inbox");
    // All / Unread filter is shown for inbox.
    expect(screen.getByTestId("inbox-filter-row")).toBeInTheDocument();
  });

  it("folder='drafts' updates header + hides All/Unread + uses drafts empty copy", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(ok({ messages: [], nextSkip: null, folder: "drafts" })),
    );
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
        folder="drafts"
      />,
    );
    await flush();
    await waitFor(() => {
      expect(screen.getByTestId("inbox-header-label")).toHaveTextContent("Drafts");
    });
    expect(screen.queryByTestId("inbox-filter-row")).toBeNull();
    expect(screen.getByTestId("inbox-empty")).toHaveTextContent(/No drafts/i);
    const urls = mockFetchWithRefresh.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u.includes("folder=drafts"))).toBe(true);
    // Drafts must NOT send unread=true even if internally toggled.
    expect(urls.some((u) => u.includes("unread=true"))).toBe(false);
  });

  it("folder='sent' updates header + hides All/Unread + uses sent empty copy", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(ok({ messages: [], nextSkip: null, folder: "sent" })),
    );
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
        folder="sent"
      />,
    );
    await flush();
    await waitFor(() => {
      expect(screen.getByTestId("inbox-header-label")).toHaveTextContent("Sent");
    });
    expect(screen.queryByTestId("inbox-filter-row")).toBeNull();
    expect(screen.getByTestId("inbox-empty")).toHaveTextContent(/No sent items/i);
  });

  it("folder='archived' shows All/Unread + uses archived empty copy", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(ok({ messages: [], nextSkip: null, folder: "archived" })),
    );
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
        folder="archived"
      />,
    );
    await flush();
    await waitFor(() => {
      expect(screen.getByTestId("inbox-header-label")).toHaveTextContent("Archived");
    });
    expect(screen.getByTestId("inbox-filter-row")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-empty")).toHaveTextContent(/No archived messages/i);
  });

  it("emits folder_loaded with folder + count + took_ms", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(ok({ messages: [], nextSkip: null, folder: "drafts" })),
    );
    render(
      <InboxPanel
        activeId={null}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
        folder="drafts"
      />,
    );
    await flush();
    await waitFor(() => {
      const evt = mockEmitInsight.mock.calls
        .map((c) => c[0])
        .find((e: any) => e.action === "folder_loaded");
      expect(evt).toBeTruthy();
      expect(evt.payload.folder).toBe("drafts");
      expect(evt.payload.count).toBe(0);
      expect(typeof evt.payload.took_ms).toBe("number");
    });
  });

  it("clicking a row in drafts emits draft_clicked_skipped (NOT thread_read)", async () => {
    mockFetchWithRefresh.mockReset();
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve(
        ok({
          messages: [
            {
              id: "draft-1",
              subject: "WIP",
              from: { name: "Me", email: "me@x.co" },
              receivedDateTime: new Date().toISOString(),
              bodyPreview: "Half-typed",
              isRead: true,
              hasAttachments: false,
              importance: "normal",
              webLink: "",
              isDraft: true,
            },
          ],
          nextSkip: null,
          folder: "drafts",
        }),
      ),
    );
    const onOpen = jest.fn();
    render(
      <InboxPanel
        activeId={null}
        onOpen={onOpen}
        onCompose={jest.fn()}
        userId="u1"
        userRole="ceo"
        folder="drafts"
      />,
    );
    await flush();
    await waitFor(() => screen.getByTestId("inbox-row-draft-1"));
    fireEvent.click(screen.getByTestId("inbox-row-draft-1"));
    const skipped = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.action === "draft_clicked_skipped");
    expect(skipped).toBeTruthy();
    expect(skipped.payload.message_id).toBe("draft-1");
    expect(skipped.payload.folder).toBe("drafts");
    const threadRead = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.action === "thread_read");
    expect(threadRead).toBeUndefined();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "draft-1" }));
  });
});
