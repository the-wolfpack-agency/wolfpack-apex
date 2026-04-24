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
  ],
};

function defaultRouter(url: string): MockResponse {
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
  // jsdom session storage isolation
  window.sessionStorage.clear();
});

async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

async function addToRecipient(email: string) {
  const input = screen.getByLabelText("To email input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: email } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("EmailsPage — inline composer", () => {
  it("renders inline composer fields (To, Subject, Body, Send, AI Draft)", async () => {
    render(<EmailsPage />);
    await flushPromises();

    expect(screen.getByLabelText("To email input")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toBeInTheDocument();
    expect(screen.getByLabelText("Email body")).toBeInTheDocument();
    expect(screen.getByTestId("compose-send")).toBeInTheDocument();
    expect(screen.getByTestId("ai-draft-btn")).toBeInTheDocument();
    // CC + BCC are hidden initially behind toggles, which is the
    // requested behaviour.
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

  it("emits insight.email.template_inserted and populates Subject + Body", async () => {
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

    const subject = screen.getByLabelText("Subject") as HTMLInputElement;
    expect(subject.value).toBe("Intro call follow-up");
    const body = screen.getByLabelText("Email body") as HTMLTextAreaElement;
    expect(body.value).toContain("Send after an introductory client call.");
    expect(body.value).toContain("clientName");
  });

  it("loads recipient insights and renders 'Recent threads (N)' + 'Last meeting' cells", async () => {
    render(<EmailsPage />);
    await flushPromises();
    await act(async () => {
      await addToRecipient("jane@example.com");
    });
    // wait for debounce + two API calls
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
      expect(loaded.payload.recent_thread_count).toBe(2);
      expect(typeof loaded.payload.last_meeting_days_ago).toBe("number");
    });
  });

  it("shows CC then collapses it via the × close button", async () => {
    render(<EmailsPage />);
    await flushPromises();

    fireEvent.click(screen.getByTestId("add-cc"));
    expect(screen.getByLabelText("CC email input")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hide-cc"));
    expect(screen.queryByLabelText("CC email input")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-cc")).toBeInTheDocument();
  });

  it("shows BCC then collapses it via the × close button", async () => {
    render(<EmailsPage />);
    await flushPromises();

    fireEvent.click(screen.getByTestId("add-bcc"));
    expect(screen.getByLabelText("BCC email input")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hide-bcc"));
    expect(screen.queryByLabelText("BCC email input")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-bcc")).toBeInTheDocument();
  });

  it("composer wrapper background is opaque (no rgba alpha < 1)", async () => {
    render(<EmailsPage />);
    await flushPromises();

    const wrap = screen.getByTestId("composer-wrap");
    const bg = (wrap as HTMLElement).style.background || "";
    // Expect a CSS variable, never a transparent rgba.
    expect(bg).toMatch(/var\(--wp-/);
    expect(bg.toLowerCase()).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
    expect(bg.toLowerCase()).not.toContain("transparent");
  });
});
