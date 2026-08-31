 
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

  test("reports busy + summarizes up to 3 overlapping meetings", async () => {
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

  test("selfUser short-circuits directory lookup and renders first-person answer", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "m1",
        subject: "Q2 Review",
        start: "2026-04-21T14:30:00Z",
        end: "2026-04-21T15:30:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
    ]);
    const out = await runCalendarAvailability({
      personName: "__self__",
      timeframeToken: "afternoon_today",
      nowMs: NOW,
      selfUser: { userId: "nick@wolfpack.dev", displayName: "Nick Homyk" },
    });
    expect(mockSafeQuery).not.toHaveBeenCalled();
    expect(mockFetchCalendarEvents).toHaveBeenCalledWith(
      "nick@wolfpack.dev",
      expect.any(String),
      expect.any(String),
    );
    expect(out?.busy).toBe(true);
    expect(out?.answer).toMatch(/^You have 1 meeting /);
    expect(out?.answer.toLowerCase()).toContain("q2 review");
    /* Vertical list, one meeting per line. */
    expect(out?.answer).toMatch(/\n-\s.*q2 review/i);
  });

  test("renders multiple meetings vertically (one per line) with webLinks", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "m1",
        subject: "1-1 Weekly Strategy",
        start: "2026-04-21T15:00:00Z",
        end: "2026-04-21T15:30:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
        webLink: "https://outlook.office.com/calendar/item/abc",
      },
      {
        id: "m2",
        subject: "Wolfpack Kickoff",
        start: "2026-04-21T18:00:00Z",
        end: "2026-04-21T19:00:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
        webLink: "https://outlook.office.com/calendar/item/def",
      },
    ]);
    const out = await runCalendarAvailability({
      personName: "__self__",
      timeframeToken: "today",
      nowMs: NOW,
      selfUser: { userId: "nick@wolfpack.dev", displayName: "Nick Homyk" },
    });
    /* Header on its own line, each meeting on its own line as a
     * Markdown bullet with the title as a link to the Outlook
     * deep-link. */
    expect(out?.answer).toMatch(/^You have 2 meetings today:\n/);
    expect(out?.answer).toContain(
      "- [1-1 Weekly Strategy](https://outlook.office.com/calendar/item/abc)",
    );
    expect(out?.answer).toContain(
      "- [Wolfpack Kickoff](https://outlook.office.com/calendar/item/def)",
    );
    /* Each meeting on its own line — count the bullets. */
    const bulletLines = out!.answer.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines).toHaveLength(2);
    /* No comma-joined inline run-on like the old format. */
    expect(out?.answer).not.toMatch(/\), .+\(/);
  });

  test("plain text title when Graph omits webLink", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "m1",
        subject: "Internal hold",
        start: "2026-04-21T15:00:00Z",
        end: "2026-04-21T15:30:00Z",
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
        /* webLink intentionally undefined */
      },
    ]);
    const out = await runCalendarAvailability({
      personName: "__self__",
      timeframeToken: "today",
      nowMs: NOW,
      selfUser: { userId: "nick@wolfpack.dev", displayName: "Nick Homyk" },
    });
    /* Bare title, no Markdown link wrapper. */
    expect(out?.answer).toMatch(/-\sInternal hold \(/);
    expect(out?.answer).not.toMatch(/\[Internal hold\]/);
  });

  test("caps the visible list at 5 with '…and N more' overflow tail", async () => {
    const events = Array.from({ length: 7 }, (_, i) => ({
      id: `m${i}`,
      subject: `Meeting ${i}`,
      start: `2026-04-21T${String(13 + i).padStart(2, "0")}:00:00Z`,
      end: `2026-04-21T${String(13 + i).padStart(2, "0")}:30:00Z`,
      location: "",
      attendees: [],
      attendeeEmails: [],
      isOnlineMeeting: false,
    }));
    mockFetchCalendarEvents.mockResolvedValue(events);
    const out = await runCalendarAvailability({
      personName: "__self__",
      timeframeToken: "today",
      nowMs: NOW,
      selfUser: { userId: "nick@wolfpack.dev", displayName: "Nick Homyk" },
    });
    const bulletLines = out!.answer.split("\n").filter((l) => l.startsWith("- "));
    /* 5 meetings + 1 overflow tail */
    expect(bulletLines).toHaveLength(6);
    expect(out?.answer).toMatch(/…and 2 more/);
  });

  test("selfUser renders first-person 'free' answer when empty", async () => {
    mockFetchCalendarEvents.mockResolvedValue([]);
    const out = await runCalendarAvailability({
      personName: "__self__",
      timeframeToken: "afternoon_today",
      nowMs: NOW,
      selfUser: { userId: "nick@wolfpack.dev", displayName: "Nick Homyk" },
    });
    expect(out?.busy).toBe(false);
    expect(out?.answer).toBe("You look free this afternoon.");
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

/* ---------------------------------------------------------------------
 * Regression 2026-08-25: "the time of meetings is blatantly wrong."
 *
 * Reported from `run my day` by a user in Eastern. A 1:00 PM meeting read
 * back as 5:00 PM: the whole UTC offset, on every meeting.
 *
 * Vercel functions run in UTC, so formatTime() without a zone formats in the
 * server's, and the caller's browser had been sending its IANA zone on every
 * turn all along. It reached the orchestrator and stopped there, so asking
 * about your calendar in a sentence was right while the identical lookup
 * inside a routine step was four hours out.
 * --------------------------------------------------------------- */
describe("whose clock the times are read in", () => {
  const meeting = {
    id: "m1",
    /* 5:00 PM UTC. In Eastern on this date (EDT, UTC-4) that is 1:00 PM. */
    subject: "A Weekend with Porsche",
    start: "2026-08-25T17:00:00Z",
    end: "2026-08-25T17:45:00Z",
    location: "",
    attendees: [],
    attendeeEmails: [],
    isOnlineMeeting: false,
  };
  const AUG = Date.parse("2026-08-25T15:00:00Z");

  const ask = (timeZone?: string) => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ user_id: "u1", display_name: "Hoxsie", mail: "hoxsie@wolfpack.dev" }],
    });
    mockFetchCalendarEvents.mockResolvedValue([meeting]);
    return runCalendarAvailability({
      personName: "Hoxsie",
      timeframeToken: "afternoon_today",
      nowMs: AUG,
      timeZone,
    });
  };

  test("an Eastern caller is told 1:00 PM, not 5:00 PM", async () => {
    const out = await ask("America/New_York");
    expect(out?.answer).toContain("1:00 PM");
    /* The exact number that was on the screen. */
    expect(out?.answer).not.toContain("5:00 PM");
  });

  test("the end of the meeting moves with it", async () => {
    expect((await ask("America/New_York"))?.answer).toContain("1:45 PM");
  });

  /* Somebody else, somewhere else, reading the same meeting. Proves the zone
     is actually applied rather than a second hardcoded default. */
  test("a London caller is told 6:00 PM", async () => {
    expect((await ask("Europe/London"))?.answer).toContain("6:00 PM");
  });
});
