/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor } from "@testing-library/react";
import { MeetingBriefPanel } from "../MeetingBriefPanel";

beforeEach(() => mockFetchWithRefresh.mockReset());

function mockBrief(payload: unknown, status = 200) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/meetings/brief")) {
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

describe("MeetingBriefPanel", () => {
  it("renders empty state when brief is null", async () => {
    mockBrief({ brief: null });
    render(
      <MeetingBriefPanel
        eventId="e1"
        eventTitle="Some random meeting"
        eventStart="2026-04-22T15:00:00Z"
        attendees={[]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("meeting-brief-e1-empty")).toBeInTheDocument(),
    );
  });

  it("renders brief with feed link, recent messages, action items, topics", async () => {
    mockBrief({
      brief: {
        feed: { id: "f1", slug: "weekly", name: "Weekly Stand-up" },
        recent_messages: [
          {
            id: "m1",
            subject: "Recap Apr 15",
            received_at: "2026-04-15T15:00:00Z",
            summary: "Pricing decisions confirmed",
            analyzed: true,
          },
        ],
        open_action_items: [
          {
            description: "Ship pricing page",
            assignee: "alice",
            source_message_id: "m1",
          },
        ],
        recurring_topics: [{ topic: "pricing", mention_count: 2 }],
        exception_count: 1,
      },
    });
    render(
      <MeetingBriefPanel
        eventId="e1"
        eventTitle="Weekly Stand-up — Apr 22"
        eventStart="2026-04-22T15:00:00Z"
        attendees={["a@x"]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("meeting-brief-e1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("meeting-brief-e1-feed-link")).toHaveTextContent(
      "Weekly Stand-up",
    );
    expect(screen.getByTestId("meeting-brief-e1-recent")).toHaveTextContent(
      "Recap Apr 15",
    );
    expect(screen.getByTestId("meeting-brief-e1-actions")).toHaveTextContent(
      "Ship pricing page",
    );
    expect(screen.getByTestId("meeting-brief-e1-topics")).toHaveTextContent(
      /pricing/i,
    );
    expect(
      screen.getByTestId("meeting-brief-e1-exceptions"),
    ).toHaveTextContent(/1 open exception/);
  });

  it("renders error state on 500", async () => {
    mockBrief({ error: "x" }, 500);
    render(
      <MeetingBriefPanel
        eventId="e1"
        eventTitle="X"
        eventStart="2026-04-22"
        attendees={[]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("meeting-brief-e1-error")).toBeInTheDocument(),
    );
  });
});
