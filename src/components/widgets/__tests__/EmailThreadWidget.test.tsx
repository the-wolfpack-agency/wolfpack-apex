/**
 * @jest-environment jsdom
 *
 * EmailThreadWidget — DOM render + analytics on mount/click + empty
 * state + Outlook deep-link wiring.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { EmailThreadWidget } from "@/components/widgets/EmailThreadWidget";
import type { EmailThreadWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

const spec: EmailThreadWidgetSpec = {
  kind: "email_thread",
  title: "Recent inbox",
  subtitle: "2 most recent",
  messages: [
    {
      id: "m-1",
      subject: "Quarterly review",
      from: "Nick Hoxsie",
      fromEmail: "hoxsie@thewolfpack.agency",
      receivedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      preview: "Hey, can you review the Q3 numbers?",
      isRead: false,
      importance: "high",
      webLink: "https://outlook.office.com/m-1",
    },
    {
      id: "m-2",
      subject: "Lunch?",
      from: "Sarah",
      fromEmail: "sarah@example.com",
      receivedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      preview: "Quick bite tomorrow at noon?",
      isRead: true,
      importance: "normal",
    },
  ],
};

describe("EmailThreadWidget", () => {
  test("renders title + subtitle + each message row", () => {
    render(<EmailThreadWidget spec={spec} />);
    expect(screen.getByTestId("email-thread-widget")).toBeInTheDocument();
    expect(screen.getByText("Recent inbox")).toBeInTheDocument();
    expect(screen.getByText("2 most recent")).toBeInTheDocument();
    expect(screen.getByTestId("email-thread-message-m-1")).toBeInTheDocument();
    expect(screen.getByTestId("email-thread-message-m-2")).toBeInTheDocument();
    expect(screen.getByText("Quarterly review")).toBeInTheDocument();
    expect(screen.getByText("Lunch?")).toBeInTheDocument();
  });

  test("Outlook deep link present when webLink set, absent otherwise", () => {
    render(<EmailThreadWidget spec={spec} />);
    /* Only one webLink set in the spec. */
    const outlookLinks = screen.getAllByText("Open in Outlook");
    expect(outlookLinks).toHaveLength(1);
    expect((outlookLinks[0] as HTMLAnchorElement).getAttribute("href")).toBe(
      "https://outlook.office.com/m-1",
    );
  });

  test("fires widget_rendered analytics on mount", () => {
    render(<EmailThreadWidget spec={spec} />);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("assistant.widget_rendered"),
      }),
    );
  });

  test("clicking 'Open full inbox' fires widget_interaction", () => {
    render(<EmailThreadWidget spec={spec} />);
    mockFetch.mockClear();
    fireEvent.click(screen.getByText("Open full inbox"));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("open_email_page"),
      }),
    );
  });

  test("empty state when no messages", () => {
    render(<EmailThreadWidget spec={{ ...spec, messages: [] }} />);
    expect(screen.getByTestId("email-thread-empty")).toBeInTheDocument();
  });
});
