/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFetchCalendarEvents = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: any[]) => mockFetchCalendarEvents(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import { runCalendarAvailability } from "@/lib/assistant/tools/calendar-availability";

const NOW = Date.parse("2026-04-21T14:00:00Z"); // Tuesday 10am EST

beforeEach(() => {
  mockFetchCalendarEvents.mockReset();
  mockSafeQuery.mockReset();
});

describe("runCalendarAvailability", () => {
  test("returns null when the person can't be resolved", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const out = await runCalendarAvailability({
      personName: "Ghost",
      timeframeToken: "afternoon_today",
      nowMs: NOW,
    });
    expect(out).toBeNull();
    expect(mockFetchCalendarEvents).not.toHaveBeenCalled();
  });

  test("reports 'looks free' when no events overlap the window", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ user_id: "u1", display_name: "Hoxsie", mail: "hoxsie@wolfpack.dev" }],
    });
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "morning",
        subject: "Standup",
        start: "2026-04-21T09:00:00Z",
        end: "2026-04-21T09:30:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
    ]);
    const out = await runCalendarAvailability({
      personName: "Hoxsie",
      timeframeToken: "afternoon_today",
      nowMs: NOW,
    });
    expect(out?.busy).toBe(false);
    expect(out?.answer).toContain("free");
    expect(out?.answer).toContain("this afternoon");
  });

  test("reports busy + summarises up to 3 overlapping meetings", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ user_id: "u1", display_name: "Hoxsie", mail: "hoxsie@wolfpack.dev" }],
    });
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "m1",
        subject: "Q2 Review",
        start: "2026-04-21T14:30:00Z", // inside afternoon (12-18 UTC)
        end: "2026-04-21T15:30:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
      {
        id: "m2",
        subject: "Investor sync",
        start: "2026-04-21T16:00:00Z",
        end: "2026-04-21T17:00:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
    ]);
    const out = await runCalendarAvailability({
      personName: "Hoxsie",
      timeframeToken: "afternoon_today",
      nowMs: NOW,
    });
    expect(out?.busy).toBe(true);
    expect(out?.events).toHaveLength(2);
    expect(out?.answer).toContain("2 meetings");
    expect(out?.answer.toLowerCase()).toContain("q2 review");
  });

  test("tolerates Graph failure by returning null (orchestrator will fall back)", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ user_id: "u1", display_name: "Hoxsie", mail: "hoxsie@wolfpack.dev" }],
    });
    mockFetchCalendarEvents.mockRejectedValue(new Error("graph 500"));
    const out = await runCalendarAvailability({
      personName: "Hoxsie",
      timeframeToken: "today",
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });
});
