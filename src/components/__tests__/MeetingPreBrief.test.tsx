/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";
/**
 * MeetingPreBrief — dashboard pre-brief tile.
 *
 * Locks:
 *   - fetches via fetchWithRefresh (never raw fetch)
 *   - fires meeting.prebrief_viewed on mount with meeting_id metadata
 *   - fires meeting.prebrief_section_expanded when a section is expanded
 *   - renders an error state when the API returns non-OK
 *   - renders attendees + threads + tasks regions
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MeetingPreBrief from "@/components/MeetingPreBrief";

const SUCCESS_PAYLOAD = {
  meeting: {
    id: "evt-1",
    subject: "Greenfield Q2 Review",
    start: "2026-04-21T14:00:00Z",
    end: "2026-04-21T15:00:00Z",
    location: "Teams",
    attendees: ["james@greenfield.com", "sarah@wolfpack.dev"],
    isOnlineMeeting: true,
  },
  attendeeEmails: ["james@greenfield.com", "sarah@wolfpack.dev"],
  recentThreads: [
    {
      id: "m2",
      subject: "Re: Retainer",
      from: "James",
      fromEmail: "james@greenfield.com",
      receivedDateTime: "2026-04-21T09:00:00Z",
      bodyPreview: "Confirmed.",
    },
  ],
  openTasks: [
    {
      id: "t-a",
      title: "Prep slides",
      status: "inProgress",
      dueAt: null,
    },
  ],
  linkedGoal: null,
  decisionSnippet: null,
};

function mockPrebriefFetch(payload: unknown, status = 200) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/meetings/prebrief/")) {
      return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload,
      });
    }
    // Any other call (analytics) resolves OK.
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("MeetingPreBrief", () => {
  test("renders the tile with attendees, threads, and tasks on success", async () => {
    mockPrebriefFetch(SUCCESS_PAYLOAD);
    render(<MeetingPreBrief meetingId="evt-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("prebrief-attendees")).toHaveTextContent(
      /james@greenfield.com/,
    );
    expect(screen.getByTestId("prebrief-threads")).toHaveTextContent(/Re: Retainer/);
    expect(screen.getByTestId("prebrief-tasks")).toHaveTextContent(/Prep slides/);
  });

  test("fires meeting.prebrief_viewed analytics with meeting_id on mount", async () => {
    mockPrebriefFetch(SUCCESS_PAYLOAD);
    render(<MeetingPreBrief meetingId="evt-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief")).toBeInTheDocument(),
    );

    const analyticsCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(analyticsCall![1].body);
    expect(body.event).toBe("meeting.prebrief_viewed");
    expect(body.metadata.meeting_id).toBe("evt-1");
    expect(body.metadata.attendee_count).toBe(2);
    expect(body.metadata.thread_count).toBe(1);
    expect(body.metadata.open_task_count).toBe(1);
    expect(body.metadata.has_linked_goal).toBe(false);
  });

  test("fires meeting.prebrief_section_expanded when a collapsed section is opened", async () => {
    mockPrebriefFetch(SUCCESS_PAYLOAD);
    render(<MeetingPreBrief meetingId="evt-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief")).toBeInTheDocument(),
    );

    mockFetchWithRefresh.mockClear();
    // "attendees" starts expanded → first click collapses (no analytics).
    await act(async () => {
      fireEvent.click(screen.getByTestId("prebrief-toggle-attendees"));
    });
    const afterCollapse = mockFetchWithRefresh.mock.calls.filter(
      (c) => c[0] === "/api/analytics",
    );
    expect(afterCollapse).toHaveLength(0);

    // Second click expands → analytics fires.
    await act(async () => {
      fireEvent.click(screen.getByTestId("prebrief-toggle-attendees"));
    });
    const expansionCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/analytics",
    );
    expect(expansionCall).toBeDefined();
    const body = JSON.parse(expansionCall![1].body);
    expect(body.event).toBe("meeting.prebrief_section_expanded");
    expect(body.metadata.meeting_id).toBe("evt-1");
    expect(body.metadata.section).toBe("attendees");
  });

  test("renders a visible error message when the API returns 404", async () => {
    mockPrebriefFetch({ error: "not_found" }, 404);
    render(<MeetingPreBrief meetingId="missing" />);

    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-error")).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Meeting not found/);
  });

  test("renders error state when fetch throws", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/meetings/prebrief/")) {
        return Promise.reject(new Error("network"));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<MeetingPreBrief meetingId="evt-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-error")).toBeInTheDocument(),
    );
  });

  test("does not use raw window.fetch — always goes through fetchWithRefresh", async () => {
    const origFetch = global.fetch;
    const fetchSpy = jest.fn(origFetch as any);
    global.fetch = fetchSpy as any;
    try {
      mockPrebriefFetch(SUCCESS_PAYLOAD);
      render(<MeetingPreBrief meetingId="evt-1" />);
      await waitFor(() =>
        expect(screen.getByTestId("meeting-prebrief")).toBeInTheDocument(),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = origFetch;
    }
  });
});
