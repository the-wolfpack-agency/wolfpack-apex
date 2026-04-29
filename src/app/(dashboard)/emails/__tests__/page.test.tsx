/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn(() => ({
  id: "u-me",
  role: "ceo",
  email: "me@x",
  name: "Tester",
}));
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
  getInstinctUser: () => mockGetInstinctUser(),
}));

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
} from "@testing-library/react";
import EmailsPage from "@/app/(dashboard)/emails/page";

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

const TEMPLATES = {
  templates: [
    {
      id: "intro-call-followup",
      name: "Intro call follow-up",
      description: "Send after an introductory client call.",
      requiredVariables: ["clientName"],
      optionalVariables: [],
    },
    {
      id: "weekly-update",
      name: "Weekly update",
      description: "Friday status email.",
      requiredVariables: ["projectName"],
      optionalVariables: ["upcomingItems"],
    },
  ],
};

const RECENT_EMAILS = {
  emails: [
    {
      id: "e1",
      subject: "Re: Onboarding deck",
      from: "Jane Doe",
      fromEmail: "jane@example.com",
      receivedDateTime: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      bodyPreview: "Looks great — let's review tomorrow.",
      isRead: true,
    },
    {
      id: "e2",
      subject: "Quick question",
      from: "Jane Doe",
      fromEmail: "jane@example.com",
      receivedDateTime: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
      bodyPreview: "Got a sec to chat?",
      isRead: true,
    },
  ],
};

const CALENDAR_RANGE = {
  events: [
    {
      id: "ev1",
      subject: "Sync with Jane",
      start: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      end: new Date(Date.now() - 5 * 24 * 3600 * 1000 + 30 * 60 * 1000).toISOString(),
      attendees: ["Jane Doe"],
      attendeeEmails: ["jane@example.com"],
    },
    {
      id: "ev2",
      subject: "Standup",
      start: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(),
      end: new Date(Date.now() - 1 * 24 * 3600 * 1000 + 30 * 60 * 1000).toISOString(),
      attendees: ["Bob"],
      attendeeEmails: ["bob@example.com"],
    },
    {
      id: "ev3",
      subject: "Old quarterly review with Jane",
      start: new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
      end: new Date(Date.now() - 200 * 24 * 3600 * 1000 + 30 * 60 * 1000).toISOString(),
      attendees: ["Jane Doe"],
      attendeeEmails: ["jane@example.com"],
    },
  ],
};

const INBOX_DEFAULT = {
  messages: [
    {
      id: "row-1",
      subject: "Re: Onboarding deck",
      from: { name: "Jane Doe", email: "jane@example.com" },
      receivedDateTime: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      bodyPreview: "Looks great",
      isRead: true,
      hasAttachments: false,
      importance: "normal",
      webLink: "https://outlook.office.com/m/r1",
    },
    {
      id: "row-2",
      subject: "Quick question",
      from: { name: "Jane Doe", email: "jane@example.com" },
      receivedDateTime: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      bodyPreview: "Got a sec",
      isRead: false,
      hasAttachments: false,
      importance: "normal",
      webLink: "https://outlook.office.com/m/r2",
    },
  ],
  nextSkip: null,
  unreadCount: 1,
};

function defaultRouter(url: string): MockResponse {
  // Order matters: the more-specific paths come first.
  if (url.startsWith("/api/emails/inbox")) return ok(INBOX_DEFAULT);
  if (url.startsWith("/api/emails")) return ok(TEMPLATES);
  if (url.startsWith("/api/microsoft?action=emails-from")) return ok(RECENT_EMAILS);
  if (url.startsWith("/api/calendar/range")) return ok(CALENDAR_RANGE);
  if (url.startsWith("/api/mail/send")) return ok({ id: "sent-1" });
  if (url.startsWith("/api/assistant/draft-reply")) return ok({ text: "Hi Jane,\n\nQuick note." });
  return ok({});
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockEmitInsight.mockReset();
  mockGetInstinctUser.mockReturnValue({ id: "u-me", role: "ceo", email: "me@x", name: "Tester" });
  mockFetchWithRefresh.mockImplementation((url: string) =>
    Promise.resolve(defaultRouter(url)),
  );
  window.sessionStorage.clear();
  try {
    window.history.replaceState({}, "", "/emails");
  } catch {
    /* noop */
  }
  if (typeof (document as any).execCommand !== "function") {
    (document as any).execCommand = () => true;
  }
  // Reset viewport to a wide default so each test starts clean.
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1400,
  });
});

async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

/**
 * Open the composer pane. The new layout starts with the EmptyState
 * shown in the right pane; tests that exercise composer behaviour
 * must open it first.
 */
async function openComposer() {
  const newBtn = await screen.findByTestId("inbox-new-email");
  fireEvent.click(newBtn);
  await flushPromises();
}

async function addToRecipient(email: string) {
  const input = screen.getByLabelText("To email input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: email } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function setBodyHtml(html: string) {
  const body = screen.getByLabelText("Email body") as HTMLDivElement;
  body.innerHTML = html;
  fireEvent.input(body);
}

// ---------------------------------------------------------------------------
// 3-column layout — new behaviour
// ---------------------------------------------------------------------------

describe("EmailsPage — 3-column layout (Gmail-style)", () => {
  it("on initial load with no thread selected, the right pane is the empty state — NOT composer or reader", async () => {
    render(<EmailsPage />);
    await flushPromises();

    expect(screen.getByTestId("emails-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-wrap")).toBeNull();
    expect(screen.queryByTestId("email-reader")).toBeNull();

    const rightPane = screen.getByTestId("right-pane");
    expect(rightPane.getAttribute("data-state")).toBe("empty");
  });

  it("clicking '+ New email' switches the right pane to the composer", async () => {
    render(<EmailsPage />);
    await flushPromises();

    expect(screen.queryByTestId("composer-wrap")).toBeNull();
    await openComposer();
    expect(screen.getByTestId("composer-wrap")).toBeInTheDocument();
    expect(screen.queryByTestId("emails-empty-state")).toBeNull();
    expect(screen.getByTestId("right-pane").getAttribute("data-state")).toBe("composer");
  });

  it("Discard returns the right pane to the empty state", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    expect(screen.getByTestId("composer-wrap")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Discard"));
    await flushPromises();

    expect(screen.queryByTestId("composer-wrap")).toBeNull();
    expect(screen.getByTestId("emails-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("right-pane").getAttribute("data-state")).toBe("empty");
  });

  it("clicking an inbox row opens the EmailReader in the right pane", async () => {
    // Add a /api/mail/<id> response so the reader can hydrate.
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url === "/api/mail/row-1") {
        return Promise.resolve(
          ok({
            message: {
              id: "row-1",
              subject: "Re: Onboarding deck",
              from: { name: "Jane Doe", email: "jane@example.com" },
              toRecipients: [],
              ccRecipients: [],
              receivedDateTime: new Date().toISOString(),
              bodyContentType: "text",
              bodyContent: "Body",
              bodyPreview: "Body",
              webLink: "",
            },
          }),
        );
      }
      return Promise.resolve(defaultRouter(url));
    });

    render(<EmailsPage />);
    await flushPromises();

    const row = await screen.findByTestId("inbox-row-row-1");
    fireEvent.click(row);
    await flushPromises();

    await waitFor(() => screen.getByTestId("email-reader"));
    expect(screen.queryByTestId("emails-empty-state")).toBeNull();
    expect(screen.queryByTestId("composer-wrap")).toBeNull();
  });

  it("clicking an inbox row mid-compose with unsaved content prompts for confirmation", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url === "/api/mail/row-1") {
        return Promise.resolve(
          ok({
            message: {
              id: "row-1",
              subject: "x",
              from: { name: "Jane", email: "jane@example.com" },
              toRecipients: [],
              ccRecipients: [],
              receivedDateTime: new Date().toISOString(),
              bodyContentType: "text",
              bodyContent: "x",
              bodyPreview: "x",
              webLink: "",
            },
          }),
        );
      }
      return Promise.resolve(defaultRouter(url));
    });
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    // Type a subject so the draft has unsaved content.
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "WIP" } });
    await flushPromises();

    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    const row = await screen.findByTestId("inbox-row-row-1");
    fireEvent.click(row);
    await flushPromises();
    expect(confirmSpy).toHaveBeenCalled();
    // Composer stayed (user clicked Cancel).
    expect(screen.getByTestId("composer-wrap")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("only one of empty / composer / reader is rendered at any viewport width", async () => {
    function setViewport(w: number) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: w,
      });
      window.dispatchEvent(new Event("resize"));
    }
    for (const w of [640, 800, 1100, 1280, 1600]) {
      setViewport(w);
      const { unmount } = render(<EmailsPage />);
      await flushPromises();
      const empty = screen.queryByTestId("emails-empty-state");
      const composer = screen.queryByTestId("composer-wrap");
      const reader = screen.queryByTestId("email-reader");
      const rendered = [empty, composer, reader].filter(Boolean);
      expect(rendered.length).toBe(1);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Right-pane state telemetry
// ---------------------------------------------------------------------------

describe("EmailsPage — right_pane_state telemetry", () => {
  it("emits insight.email.right_pane_state with state=empty on mount", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const e = events.find(
      (x: any) => x.surface === "email" && x.action === "right_pane_state",
    );
    expect(e).toBeTruthy();
    expect(e.payload.state).toBe("empty");
  });

  it("transitions empty -> composer -> empty emit two more right_pane_state events", async () => {
    render(<EmailsPage />);
    await flushPromises();
    mockEmitInsight.mockClear();
    await openComposer();
    fireEvent.click(screen.getByText("Discard"));
    await flushPromises();
    const transitions = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.action === "right_pane_state")
      .map((e: any) => e.payload.state);
    expect(transitions).toEqual(["composer", "empty"]);
  });
});

// ---------------------------------------------------------------------------
// Inline composer behaviour (preserved from PR #29)
// ---------------------------------------------------------------------------

describe("EmailsPage — inline composer", () => {
  it("renders composer fields after opening the composer (To, Subject, Body, Send, AI Draft)", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    expect(screen.getByLabelText("To email input")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toBeInTheDocument();
    expect(screen.getByLabelText("Email body")).toBeInTheDocument();
    expect(screen.getByTestId("compose-send")).toBeInTheDocument();
    expect(screen.getByTestId("ai-draft-btn")).toBeInTheDocument();
    expect(screen.getByTestId("add-cc")).toBeInTheDocument();
    expect(screen.getByTestId("add-bcc")).toBeInTheDocument();
  });

  it("emits insight.email.compose_opened on mount", async () => {
    render(<EmailsPage />);
    await flushPromises();

    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const opened = events.find(
      (e: any) => e.surface === "email" && e.action === "compose_opened",
    );
    expect(opened).toBeTruthy();
    expect(opened.tier).toBe("personal");
  });

  it("emits insight.email.recipient_set with the email as target when To: chip added", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();

    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const recipient = events.find(
      (e: any) => e.surface === "email" && e.action === "recipient_set",
    );
    expect(recipient).toBeTruthy();
    expect(recipient.target).toBe("jane@example.com");
    expect(recipient.tier).toBe("org");
  });

  it("emits insight.email.template_inserted, opens the composer, populates Subject + Body", async () => {
    render(<EmailsPage />);
    await flushPromises();

    const tmplBtn = await screen.findByTestId("template-intro-call-followup");
    fireEvent.click(tmplBtn);
    await flushPromises();

    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const tmpl = events.find(
      (e: any) => e.surface === "email" && e.action === "template_inserted",
    );
    expect(tmpl).toBeTruthy();
    expect(tmpl.target).toBe("intro-call-followup");

    // Template insertion implicitly opens the composer.
    expect(screen.getByTestId("composer-wrap")).toBeInTheDocument();
    const subject = screen.getByLabelText("Subject") as HTMLInputElement;
    expect(subject.value).toBe("Intro call follow-up");
    const body = screen.getByLabelText("Email body") as HTMLDivElement;
    expect(body.innerHTML).toContain("Send after an introductory client call.");
    expect(body.innerHTML).toContain("clientName");
    expect(body.innerHTML).toContain("<br>");
  });

  it("loads recipient insights and renders 'Recent threads (N)' + 'Last meeting' cells", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    await waitFor(() => {
      expect(screen.getByTestId("insight-recent-threads")).toBeInTheDocument();
    });
    expect(screen.getByText(/Recent threads \(2\)/i)).toBeInTheDocument();
    expect(screen.getByTestId("insight-last-meeting")).toBeInTheDocument();
    expect(screen.getByText(/Sync with Jane/)).toBeInTheDocument();
  });

  it("emits insight.email.insights_loaded once insights arrive", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    await waitFor(() => {
      const events = mockEmitInsight.mock.calls.map((c) => c[0]);
      const loaded = events.find(
        (e: any) => e.surface === "email" && e.action === "insights_loaded",
      );
      expect(loaded).toBeTruthy();
      expect(loaded.payload.recipient).toBe("jane@example.com");
      expect(loaded.payload.recipient_count).toBe(1);
      expect(loaded.payload.mode).toBe("single");
    });
  });

  it("shows CC then collapses it via the × close button", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    fireEvent.click(screen.getByTestId("add-cc"));
    expect(screen.getByLabelText("CC email input")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hide-cc"));
    expect(screen.queryByLabelText("CC email input")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-cc")).toBeInTheDocument();
  });

  it("shows BCC then collapses it via the × close button", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    fireEvent.click(screen.getByTestId("add-bcc"));
    expect(screen.getByLabelText("BCC email input")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hide-bcc"));
    expect(screen.queryByLabelText("BCC email input")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-bcc")).toBeInTheDocument();
  });

  it("composer wrapper background is opaque (no rgba alpha < 1)", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    const wrap = screen.getByTestId("composer-wrap");
    const bg = (wrap as HTMLElement).style.background || "";
    expect(bg).toMatch(/var\(--wp-/);
    expect(bg.toLowerCase()).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
    expect(bg.toLowerCase()).not.toContain("transparent");
  });
});

// ---------------------------------------------------------------------------
// Rich text body editor
// ---------------------------------------------------------------------------

describe("EmailsPage — rich text body editor", () => {
  it("Bold toolbar button calls execCommand('bold') and emits format_applied", async () => {
    const execSpy = jest
      .spyOn(document, "execCommand")
      .mockImplementation(() => true);

    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    fireEvent.click(screen.getByTestId("format-bold"));

    expect(execSpy).toHaveBeenCalledWith("bold", false);

    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const fmt = events.find(
      (e: any) => e.surface === "email" && e.action === "format_applied",
    );
    expect(fmt).toBeTruthy();
    expect(fmt.payload.format).toBe("bold");
    expect(fmt.tier).toBe("personal");

    execSpy.mockRestore();
  });

  it("Italic / Underline / UL / OL toolbar buttons each fire execCommand + emit", async () => {
    const execSpy = jest
      .spyOn(document, "execCommand")
      .mockImplementation(() => true);

    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    fireEvent.click(screen.getByTestId("format-italic"));
    fireEvent.click(screen.getByTestId("format-underline"));
    fireEvent.click(screen.getByTestId("format-ul"));
    fireEvent.click(screen.getByTestId("format-ol"));

    expect(execSpy).toHaveBeenCalledWith("italic", false);
    expect(execSpy).toHaveBeenCalledWith("underline", false);
    expect(execSpy).toHaveBeenCalledWith("insertUnorderedList", false);
    expect(execSpy).toHaveBeenCalledWith("insertOrderedList", false);

    const formats = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.action === "format_applied")
      .map((e: any) => e.payload.format);
    expect(formats).toEqual(["italic", "underline", "ul", "ol"]);

    execSpy.mockRestore();
  });

  it("AI Draft escapes HTML in the model output and converts \\n to <br>", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url.startsWith("/api/assistant/draft-reply")) {
        return Promise.resolve(
          ok({ text: "Hi <script>alert(1)</script>\nLine two" }),
        );
      }
      return Promise.resolve(defaultRouter(url));
    });

    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    fireEvent.click(screen.getByTestId("ai-draft-btn"));
    await flushPromises();
    await flushPromises();

    const body = screen.getByLabelText("Email body") as HTMLDivElement;
    expect(body.innerHTML).toContain("&lt;script&gt;");
    expect(body.innerHTML).not.toContain("<script>");
    expect(body.innerHTML).toContain("<br>");
  });

  it("Send POSTs both bodyHtml AND bodyText", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();

    const subject = screen.getByLabelText("Subject") as HTMLInputElement;
    fireEvent.change(subject, { target: { value: "Hello" } });

    setBodyHtml("<b>Hi</b> Jane,<br>Cheers");
    await flushPromises();

    fireEvent.click(screen.getByTestId("compose-send"));
    await flushPromises();
    await flushPromises();

    const sendCall = mockFetchWithRefresh.mock.calls.find(
      ([url]) => typeof url === "string" && url.startsWith("/api/mail/send"),
    );
    expect(sendCall).toBeTruthy();
    const body = JSON.parse(sendCall![1].body);
    expect(typeof body.bodyHtml).toBe("string");
    expect(typeof body.bodyText).toBe("string");
    expect(body.bodyHtml).toContain("<b>Hi</b>");
    expect(body.bodyText).toContain("Hi");
    expect(body.bodyText).not.toContain("<b>");
  });

  it("body HTML is persisted to sessionStorage", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    setBodyHtml("<b>Saved</b>");
    await flushPromises();

    const raw = window.sessionStorage.getItem("mail.compose.draft");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.body).toContain("<b>Saved</b>");
  });
});

// ---------------------------------------------------------------------------
// Multi-recipient insights
// ---------------------------------------------------------------------------

describe("EmailsPage — multi-recipient insights", () => {
  it("renders 3 compact recipient cards when there are 3 To: recipients", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("a@example.com");
    });
    await act(async () => {
      await addToRecipient("b@example.com");
    });
    await act(async () => {
      await addToRecipient("c@example.com");
    });
    await flushPromises();
    await flushPromises();

    await waitFor(() => {
      expect(screen.getByTestId("insight-multi")).toBeInTheDocument();
    });
    expect(screen.getByTestId("recipient-card-a@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("recipient-card-b@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("recipient-card-c@example.com")).toBeInTheDocument();
  });

  it("clicking a recipient card emits insight.email.recipient_card_expanded", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("a@example.com");
    });
    await act(async () => {
      await addToRecipient("b@example.com");
    });
    await flushPromises();
    await flushPromises();

    fireEvent.click(screen.getByTestId("recipient-card-a@example.com"));

    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const expanded = events.find(
      (e: any) => e.surface === "email" && e.action === "recipient_card_expanded",
    );
    expect(expanded).toBeTruthy();
    expect(expanded.target).toBe("a@example.com");
  });

  it("renders aggregate summary and skips per-recipient Graph fetches at 6+ recipients", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    const recipients = ["a", "b", "c", "d", "e", "f"].map(
      (l) => `${l}@example.com`,
    );
    for (const r of recipients) {
      await act(async () => {
        await addToRecipient(r);
      });
    }
    await flushPromises();
    await flushPromises();

    await waitFor(() => {
      expect(screen.getByTestId("insight-aggregate")).toBeInTheDocument();
    });

    const emailsFromCalls = mockFetchWithRefresh.mock.calls.filter(
      ([url]) =>
        typeof url === "string" && url.startsWith("/api/microsoft?action=emails-from"),
    );
    expect(emailsFromCalls.length).toBe(0);

    const events = mockEmitInsight.mock.calls.map((c) => c[0]);
    const loaded = events.find(
      (e: any) => e.surface === "email" && e.action === "insights_loaded",
    );
    expect(loaded).toBeTruthy();
    expect(loaded.payload.mode).toBe("aggregate");
    expect(loaded.payload.recipient_count).toBe(6);
    expect(loaded.payload.per_recipient_fetched).toBe(0);
  });

  it("emits insights_loaded ONCE per insights-load batch with recipient_count", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("a@example.com");
    });
    await act(async () => {
      await addToRecipient("b@example.com");
    });
    await flushPromises();
    await flushPromises();

    const loadedEvents = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .filter(
        (e: any) => e.surface === "email" && e.action === "insights_loaded",
      );
    const last = loadedEvents[loadedEvents.length - 1];
    expect(last).toBeTruthy();
    expect(last.payload.recipient_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Calendar lookup window
// ---------------------------------------------------------------------------

describe("EmailsPage — wider calendar lookup window", () => {
  it("hits /api/calendar/range with view=year (not view=month)", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    const calCalls = mockFetchWithRefresh.mock.calls.filter(
      ([url]) => typeof url === "string" && url.startsWith("/api/calendar/range"),
    );
    expect(calCalls.length).toBeGreaterThan(0);
    for (const [url] of calCalls) {
      expect(url).toContain("view=year");
      expect(url).not.toContain("view=month");
    }
  });

  it("caches calendar result; switching recipients does not re-hit /api/calendar/range", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    const callsAfterFirst = mockFetchWithRefresh.mock.calls.filter(
      ([url]) => typeof url === "string" && url.startsWith("/api/calendar/range"),
    ).length;
    expect(callsAfterFirst).toBe(1);

    const toInput = screen.getByLabelText("To email input") as HTMLInputElement;
    fireEvent.keyDown(toInput, { key: "Backspace" });
    await flushPromises();

    await act(async () => {
      await addToRecipient("bob@example.com");
    });
    await flushPromises();
    await flushPromises();

    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    const callsAfterSwap = mockFetchWithRefresh.mock.calls.filter(
      ([url]) => typeof url === "string" && url.startsWith("/api/calendar/range"),
    ).length;
    expect(callsAfterSwap).toBe(1);
  });

  it("caches per-recipient emails-from: switching back to a known recipient does not re-fetch", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    const janeCallsFirst = mockFetchWithRefresh.mock.calls.filter(
      ([url]) =>
        typeof url === "string" &&
        url.startsWith("/api/microsoft?action=emails-from") &&
        url.includes("jane%40example.com"),
    ).length;
    expect(janeCallsFirst).toBe(1);

    const toInput = screen.getByLabelText("To email input") as HTMLInputElement;
    fireEvent.keyDown(toInput, { key: "Backspace" });
    await flushPromises();

    await act(async () => {
      await addToRecipient("bob@example.com");
    });
    await flushPromises();
    await flushPromises();

    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    await flushPromises();
    await flushPromises();

    const janeCallsAfter = mockFetchWithRefresh.mock.calls.filter(
      ([url]) =>
        typeof url === "string" &&
        url.startsWith("/api/microsoft?action=emails-from") &&
        url.includes("jane%40example.com"),
    ).length;
    expect(janeCallsAfter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Responsive layout regressions
// ---------------------------------------------------------------------------

describe("EmailsPage — responsive layout", () => {
  function setViewport(w: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: w,
    });
    window.dispatchEvent(new Event("resize"));
  }

  it("uses a row layout on wide viewports (no flex-wrap)", async () => {
    setViewport(1400);
    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("emails-page"));
    const wide = screen.getByTestId("emails-page");
    expect(wide.style.flexDirection).toBe("row");
    expect(wide.style.flexWrap).toBe("nowrap");
    expect(wide.style.overflow).toBe("hidden");
  });

  it("stacks vertically and enables scroll on mobile", async () => {
    setViewport(400);
    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("emails-page"));
    const narrow = screen.getByTestId("emails-page");
    expect(narrow.style.flexDirection).toBe("column");
    expect(narrow.style.overflow).toBe("auto");
  });

  it("mobile layout reserves bottom padding so the FAB does not cover Send", async () => {
    setViewport(400);
    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("emails-page"));
    const page = screen.getByTestId("emails-page");
    expect(page.style.paddingBottom).toBe("6rem");
  });

  it("wide viewport does NOT add the mobile bottom padding", async () => {
    setViewport(1400);
    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("emails-page"));
    const page = screen.getByTestId("emails-page");
    expect(page.style.paddingBottom).not.toBe("6rem");
  });

  it("action buttons never wrap their label text", async () => {
    setViewport(400);
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    await waitFor(() => screen.getByTestId("ai-draft-btn"));
    expect(screen.getByTestId("ai-draft-btn").style.whiteSpace).toBe("nowrap");
    expect(screen.getByTestId("compose-send").style.whiteSpace).toBe("nowrap");
  });
});

// ---------------------------------------------------------------------------
// Nav rail toggle telemetry
// ---------------------------------------------------------------------------

describe("EmailsPage — nav rail", () => {
  it("toggling the nav rail emits insight.email.nav_rail_toggled", async () => {
    render(<EmailsPage />);
    await flushPromises();
    mockEmitInsight.mockClear();
    fireEvent.click(screen.getByTestId("nav-rail-toggle"));
    fireEvent.click(screen.getByTestId("nav-rail-toggle"));
    const events = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.action === "nav_rail_toggled");
    expect(events.length).toBe(2);
    // First toggle from default (expanded) → collapsed; second back to expanded.
    expect(events[0].payload.expanded).toBe(false);
    expect(events[1].payload.expanded).toBe(true);
  });

  it("does NOT render the nav rail on mobile viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 400,
    });
    render(<EmailsPage />);
    await flushPromises();
    expect(screen.queryByTestId("email-nav-rail")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recipient context drawer telemetry
// ---------------------------------------------------------------------------

describe("EmailsPage — recipient context drawer", () => {
  it("toggling the drawer emits insight.email.recipient_context_toggled with viewport class", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1400,
    });
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    mockEmitInsight.mockClear();
    // Drawer is open on wide by default, so first toggle closes it.
    fireEvent.click(screen.getByTestId("recipient-context-toggle"));
    await flushPromises();
    fireEvent.click(screen.getByTestId("recipient-context-rail-collapsed"));
    await flushPromises();
    const events = mockEmitInsight.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.action === "recipient_context_toggled");
    expect(events.length).toBe(2);
    expect(events[0].payload.open).toBe(false);
    expect(events[0].payload.viewport).toBe("wide");
    expect(events[1].payload.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deep-link reading view
// ---------------------------------------------------------------------------

describe("EmailsPage — deep-link reading view (?id=<graphMessageId>)", () => {
  test("?id=<id> swaps the page into the EmailReader fetched from /api/mail/<id>", async () => {
    window.history.replaceState({}, "", "/emails?id=msg-deep-1");
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url === "/api/mail/msg-deep-1") {
        return Promise.resolve(
          ok({
            message: {
              id: "msg-deep-1",
              subject: "Deep linked thread",
              from: { name: "James", email: "james@example.test" },
              toRecipients: [{ name: "Nick", email: "nick@x.test" }],
              ccRecipients: [],
              receivedDateTime: "2026-04-22T10:00:00Z",
              bodyContentType: "text",
              bodyContent: "Hello from search",
              bodyPreview: "Hello",
              webLink: "https://outlook.office.com/m/x",
            },
          }),
        );
      }
      return Promise.resolve(defaultRouter(url));
    });

    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("emails-page"));
    await waitFor(() =>
      expect(screen.getByTestId("email-reader")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("To email input")).toBeNull();
    expect(screen.getByTestId("email-reader-subject").textContent).toBe(
      "Deep linked thread",
    );
    const calls = mockFetchWithRefresh.mock.calls.map((c: any) => c[0]);
    expect(calls).toContain("/api/mail/msg-deep-1");
  });

  test("Back button drops out of reading view, clears ?id=, and shows the empty state", async () => {
    window.history.replaceState({}, "", "/emails?id=msg-deep-2");
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url === "/api/mail/msg-deep-2") {
        return Promise.resolve(
          ok({
            message: {
              id: "msg-deep-2",
              subject: "x",
              from: { name: "x", email: "x@x.test" },
              toRecipients: [],
              ccRecipients: [],
              receivedDateTime: "2026-04-22T10:00:00Z",
              bodyContentType: "text",
              bodyContent: "x",
              bodyPreview: "x",
              webLink: "",
            },
          }),
        );
      }
      return Promise.resolve(defaultRouter(url));
    });
    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("email-reader"));

    fireEvent.click(screen.getByTestId("email-reader-back"));

    await waitFor(() =>
      expect(screen.queryByTestId("email-reader")).toBeNull(),
    );
    // The empty state replaces the reader (composer is NOT auto-opened).
    expect(screen.getByTestId("emails-empty-state")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  test("?id=<id> with empty/whitespace value falls through to empty state", async () => {
    window.history.replaceState({}, "", "/emails?id=%20%20");
    render(<EmailsPage />);
    await waitFor(() => screen.getByTestId("emails-page"));
    expect(screen.queryByTestId("email-reader")).toBeNull();
    expect(screen.getByTestId("emails-empty-state")).toBeInTheDocument();
  });
});
