/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";
/**
 * MeetingPreBriefPanel — dashboard wrapper with meeting picker.
 *
 * Locks:
 *   - fetches /api/meetings/upcoming on mount with the lookahead hours
 *   - defaults to the first upcoming meeting (no longer hidden until 15m pre-start)
 *   - shows the "in progress" meeting if one exists
 *   - renders the meeting picker with all meetings in the window
 *   - fires meeting.prebrief_meeting_selected when the user switches meetings
 *   - renders empty state when the API returns 0 meetings
 *   - renders error state on non-OK
 *   - hides entirely on 401/403 (capability gate)
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

// Stub the inner prebrief so the panel test focuses only on the wrapper.
jest.mock("@/components/MeetingPreBrief", () => {
  return function StubPrebrief({ meetingId }: { meetingId: string }) {
    return <div data-testid="stub-prebrief">{`prebrief-for:${meetingId}`}</div>;
  };
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MeetingPreBriefPanel from "@/components/MeetingPreBriefPanel";

function meeting(over: Partial<{
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  isOnlineMeeting: boolean;
  minutesUntil: number | null;
  inProgress: boolean;
}> = {}) {
  return {
    id: "evt-1",
    subject: "Q2 Review",
    start: "2026-04-21T14:00:00Z",
    end: "2026-04-21T15:00:00Z",
    location: "Teams",
    attendees: ["a@b.co"],
    isOnlineMeeting: true,
    minutesUntil: 180,
    inProgress: false,
    ...over,
  };
}

function mockUpcoming(meetings: unknown[], status = 200) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/meetings/upcoming")) {
      return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: async () => ({ meetings }),
      });
    }
    // Analytics sink
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("MeetingPreBriefPanel", () => {
  test("fetches /api/meetings/upcoming with default 48h and renders the picker", async () => {
    mockUpcoming([
      meeting({ id: "a", subject: "Standup", minutesUntil: 30 }),
      meeting({ id: "b", subject: "Client call", minutesUntil: 180 }),
    ]);

    render(<MeetingPreBriefPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel")).toBeInTheDocument(),
    );

    const firstCall = mockFetchWithRefresh.mock.calls[0];
    expect(firstCall[0]).toContain("/api/meetings/upcoming?hours=48");

    const picker = screen.getByTestId("prebrief-meeting-picker") as HTMLSelectElement;
    expect(picker.options).toHaveLength(2);
    // Default selection is the soonest upcoming (meeting a, 30 min out)
    expect(picker.value).toBe("a");
    expect(screen.getByTestId("stub-prebrief")).toHaveTextContent("prebrief-for:a");
  });

  test("defaults to in-progress meeting when one exists", async () => {
    mockUpcoming([
      meeting({ id: "soon", minutesUntil: 30, inProgress: false }),
      meeting({ id: "live", minutesUntil: -5, inProgress: true }),
      meeting({ id: "later", minutesUntil: 120, inProgress: false }),
    ]);

    render(<MeetingPreBriefPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel")).toBeInTheDocument(),
    );
    const picker = screen.getByTestId("prebrief-meeting-picker") as HTMLSelectElement;
    expect(picker.value).toBe("live");
    expect(screen.getByTestId("stub-prebrief")).toHaveTextContent("prebrief-for:live");
  });

  test("switching the dropdown fires meeting.prebrief_meeting_selected and re-renders the prebrief", async () => {
    mockUpcoming([
      meeting({ id: "a", subject: "A", minutesUntil: 10 }),
      meeting({ id: "b", subject: "B", minutesUntil: 240 }),
    ]);
    render(<MeetingPreBriefPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("prebrief-meeting-picker"), {
      target: { value: "b" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("stub-prebrief")).toHaveTextContent("prebrief-for:b"),
    );

    const analyticsCall = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeTruthy();
    const body = JSON.parse(analyticsCall![1].body);
    expect(body.event).toBe("meeting.prebrief_meeting_selected");
    expect(body.metadata.meeting_id).toBe("b");
  });

  test("renders empty-state tile when no meetings are returned", async () => {
    mockUpcoming([]);
    render(<MeetingPreBriefPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("stub-prebrief")).toBeNull();
  });

  test("renders error tile when the API fails", async () => {
    mockUpcoming([], 500);
    render(<MeetingPreBriefPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel-error")).toBeInTheDocument(),
    );
  });

  test("hides entirely when the caller lacks the meetings.view capability (403)", async () => {
    mockUpcoming([], 403);
    const { container } = render(<MeetingPreBriefPanel />);
    await waitFor(() => {
      // Loading state should have cleared, and we render nothing.
      expect(screen.queryByTestId("meeting-prebrief-panel-loading")).toBeNull();
    });
    expect(screen.queryByTestId("meeting-prebrief-panel")).toBeNull();
    expect(screen.queryByTestId("meeting-prebrief-panel-error")).toBeNull();
    expect(screen.queryByTestId("meeting-prebrief-panel-empty")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  test("countdown ticks forward from client clock — ignores stale server minutesUntil", async () => {
    // Fix "now" to 3:10 PM UTC. Meeting starts at 3:30 PM UTC → 20m away.
    // Server sent minutesUntil=71 (stale — was captured at 2:19 PM). We
    // expect the UI to show "in 20m", not "in 1h 11m".
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-04-21T15:10:00Z"));
    mockUpcoming([
      meeting({
        id: "stale",
        subject: "PCBA",
        start: "2026-04-21T15:30:00Z",
        end: "2026-04-21T16:45:00Z",
        minutesUntil: 71, // frozen stale server value
        inProgress: false,
      }),
    ]);

    render(<MeetingPreBriefPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("prebrief-countdown")).toHaveTextContent(/in 20m/);

    // Advance 10 real minutes → countdown should tick to "in 10m"
    jest.setSystemTime(Date.parse("2026-04-21T15:20:00Z"));
    jest.advanceTimersByTime(30_000);
    await waitFor(() =>
      expect(screen.getByTestId("prebrief-countdown")).toHaveTextContent(/in 10m/),
    );

    // Cross the start boundary → "In progress"
    jest.setSystemTime(Date.parse("2026-04-21T15:35:00Z"));
    jest.advanceTimersByTime(30_000);
    await waitFor(() =>
      expect(screen.getByTestId("prebrief-countdown")).toHaveTextContent(/In progress/),
    );
    jest.useRealTimers();
  });

  test("respects custom lookaheadHours in the request URL", async () => {
    mockUpcoming([]);
    render(<MeetingPreBriefPanel lookaheadHours={24} />);
    await waitFor(() =>
      expect(screen.getByTestId("meeting-prebrief-panel-empty")).toBeInTheDocument(),
    );
    expect(mockFetchWithRefresh.mock.calls[0][0]).toContain("hours=24");
  });

  describe("out-of-office handling", () => {
    function mockUpcomingWithOoo(meetings: unknown[], outOfOffice: unknown[]): void {
      mockFetchWithRefresh.mockImplementation((url: string) => {
        if (typeof url === "string" && url.startsWith("/api/meetings/upcoming")) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: async () => ({ meetings, outOfOffice }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      });
    }

    test("renders 'Out today' line above the dropdown when outOfOffice entries are returned", async () => {
      mockUpcomingWithOoo(
        [meeting({ id: "real", subject: "Q2 Review" })],
        [
          meeting({ id: "o1", subject: "Ashley OOO", isOutOfOffice: true } as never),
          meeting({ id: "o2", subject: "Hoxsie OoO", isOutOfOffice: true } as never),
        ],
      );
      render(<MeetingPreBriefPanel />);
      const ooo = await screen.findByTestId("prebrief-out-of-office");
      expect(ooo).toHaveTextContent(/Out today/);
      expect(ooo).toHaveTextContent(/Ashley/);
      expect(ooo).toHaveTextContent(/Hoxsie/);
    });

    test("does NOT include OOO entries in the meeting dropdown", async () => {
      mockUpcomingWithOoo(
        [meeting({ id: "real", subject: "Q2 Review" })],
        [meeting({ id: "o1", subject: "Ashley OOO", isOutOfOffice: true } as never)],
      );
      render(<MeetingPreBriefPanel />);
      const picker = await screen.findByTestId("prebrief-meeting-picker");
      const optionTexts = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
      expect(optionTexts.join(" ")).toContain("Q2 Review");
      expect(optionTexts.join(" ")).not.toContain("Ashley OOO");
    });

    test("hides the OOO line entirely when no OOO entries are returned", async () => {
      mockUpcomingWithOoo([meeting({ id: "real", subject: "Q2 Review" })], []);
      render(<MeetingPreBriefPanel />);
      await screen.findByTestId("prebrief-meeting-picker");
      expect(screen.queryByTestId("prebrief-out-of-office")).toBeNull();
    });

    test("renders OOO line in the empty-meetings state when only OOO entries exist", async () => {
      mockUpcomingWithOoo(
        [],
        [
          meeting({ id: "o1", subject: "Ashley OOO", isOutOfOffice: true } as never),
          meeting({ id: "o2", subject: "Hoxsie Vacation", isOutOfOffice: true } as never),
        ],
      );
      render(<MeetingPreBriefPanel />);
      await screen.findByTestId("meeting-prebrief-panel-empty");
      const ooo = screen.getByTestId("prebrief-out-of-office");
      expect(ooo).toHaveTextContent(/Out today/);
      expect(ooo).toHaveTextContent(/Ashley/);
      expect(ooo).toHaveTextContent(/Hoxsie/);
    });

    test("strips OOO tokens from the display label", async () => {
      mockUpcomingWithOoo(
        [meeting({ id: "real", subject: "Q2 Review" })],
        [
          meeting({ id: "o1", subject: "Ashley OOO", isOutOfOffice: true } as never),
          meeting({ id: "o2", subject: "Hoxsie - Out of office", isOutOfOffice: true } as never),
        ],
      );
      render(<MeetingPreBriefPanel />);
      const ooo = await screen.findByTestId("prebrief-out-of-office");
      // Stripped labels, not the raw "Ashley OOO" / "Hoxsie - Out of office".
      expect(ooo).toHaveTextContent(/Ashley/);
      expect(ooo).toHaveTextContent(/Hoxsie/);
      expect(ooo.textContent).not.toMatch(/OOO/);
      expect(ooo.textContent).not.toMatch(/Out of office/i);
    });
  });
});
