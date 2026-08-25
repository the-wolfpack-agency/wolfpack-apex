 
const mockSafeQuery = jest.fn();
const mockListEvents = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/integrations/microsoft-calendar", () => ({
  listEvents: (...a: any[]) => mockListEvents(...a),
}));

import {
  extractExplicitDate,
  runMeetingsOnDate,
} from "@/lib/assistant/tools/meetings-on-date";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockSafeQuery.mockReset();
  mockListEvents.mockReset();
  mockListEvents.mockResolvedValue([]);
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("extractExplicitDate", () => {
  test("parses 'April 21, 2026'", () => {
    const r = extractExplicitDate("which meetings on April 21, 2026 ?");
    expect(r).not.toBeNull();
    expect(new Date(r!.startMs).toISOString().slice(0, 10)).toBe("2026-04-21");
  });

  test("parses ISO 2026-04-21", () => {
    const r = extractExplicitDate("meetings 2026-04-21");
    expect(r?.startMs).toBe(Date.UTC(2026, 3, 21));
  });

  test("parses 4/21/2026", () => {
    const r = extractExplicitDate("meetings on 4/21/2026");
    expect(r?.startMs).toBe(Date.UTC(2026, 3, 21));
  });

  test("returns null when no date present", () => {
    expect(extractExplicitDate("which meetings did wolfpack have")).toBeNull();
  });
});

describe("runMeetingsOnDate", () => {
  test("returns null without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const r = await runMeetingsOnDate({
      question: "meetings on April 21, 2026",
    });
    expect(r).toBeNull();
  });

  test("returns null when no date in question", async () => {
    const r = await runMeetingsOnDate({ question: "what is wolfpack" });
    expect(r).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("formats answer with the matched meetings (transcript source)", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "m1",
            title: "PCBA_E4_Content Weekly Status Call",
            summary: null,
            recorded_at: "2026-04-21T19:30:00Z",
            duration_seconds: 4500,
            owner_name: "Jorge Colon",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const r = await runMeetingsOnDate({
      question: "which meetings did wolfpack have on April 21, 2026 ?",
    });
    expect(r).not.toBeNull();
    expect(r!.meetings).toHaveLength(1);
    expect(r!.answer).toContain("PCBA_E4_Content Weekly Status Call");
    expect(r!.answer).toContain("Jorge Colon");
    expect(r!.answer).toContain("[Meetings](/meetings)");
  });

  test("merges Teams meetings (instinct_online_meetings) into the answer", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "om1",
            ms_meeting_id: "ms-1",
            subject: "Wolfpack Weekly Kickoff",
            start_at: "2026-04-20T18:00:00Z",
            end_at: "2026-04-20T19:00:00Z",
            owner_name: "Nick Hoxsie",
          },
        ],
      });
    const r = await runMeetingsOnDate({
      question: "which meetings did wolfpack have on April 20, 2026 ?",
    });
    expect(r).not.toBeNull();
    expect(r!.meetings.map((m) => m.title)).toEqual([
      "Wolfpack Weekly Kickoff",
    ]);
  });

  test("merges live MS calendar events when userId is supplied", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    mockListEvents.mockResolvedValue([
      {
        id: "ev1",
        subject: "Pre-Meeting - Kate Nelson",
        start: "2026-04-20T19:00:00Z",
        end: "2026-04-20T19:30:00Z",
        location: "",
        attendees: ["Jorge Colon", "Nick Hoxsie", "Nick Homyk"],
        attendeeEmails: [],
        isOnlineMeeting: true,
      },
    ]);
    const r = await runMeetingsOnDate({
      question: "which meetings did wolfpack have on April 20, 2026 ?",
      userId: "u-nick",
    });
    expect(r).not.toBeNull();
    expect(r!.meetings.map((m) => m.title)).toEqual([
      "Pre-Meeting - Kate Nelson",
    ]);
    expect(r!.answer).toContain("Jorge Colon");
  });

  test("empty result lists ONLY integrated surfaces (Plaud not integrated → not listed)", async () => {
    /* Sequence of queries the tool runs:
       1) instinct_meeting_transcripts SELECT  → rows: []
       2) instinct_online_meetings SELECT      → rows: []
       3) Plaud probe (EXISTS)                 → exists: false (not integrated)
       4) Teams probe  (EXISTS)                → exists: true  (integrated)
       5) Outlook token probe (EXISTS)         → exists: true  (user has MS token) */
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [] }) // transcripts
      .mockResolvedValueOnce({ rows: [] }) // online_meetings
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // Plaud probe
      .mockResolvedValueOnce({ rows: [{ exists: true }] })  // Teams probe
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // MS token probe
    mockListEvents.mockResolvedValue([]);
    const r = await runMeetingsOnDate({
      question: "meetings on 2026-04-21",
      userId: "u-1",
    });
    expect(r).not.toBeNull();
    expect(r!.meetings).toEqual([]);
    expect(r!.answer).toMatch(/^No meetings found/);
    expect(r!.answer).not.toContain("Plaud");
    expect(r!.answer).toContain("Microsoft Teams meetings");
    expect(r!.answer).toContain("Outlook calendar");
  });

  test("empty result with NO integrations connected says so plainly", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [] }) // transcripts
      .mockResolvedValueOnce({ rows: [] }) // online_meetings
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // Plaud probe
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // Teams probe
      .mockResolvedValueOnce({ rows: [{ exists: false }] }); // MS token probe
    mockListEvents.mockResolvedValue([]);
    const r = await runMeetingsOnDate({
      question: "meetings on 2026-04-21",
      userId: "u-1",
    });
    expect(r).not.toBeNull();
    expect(r!.answer).toMatch(/in any connected source/);
    expect(r!.answer).toMatch(/No meeting integrations are connected/);
  });
});

/* ---------------------------------------------------------------------
 * Sibling of the display bug fixed in #389: the same server-in-UTC cause,
 * one layer down. #389 made times read in the caller's zone; this makes the
 * DAY they are grouped under the caller's day too.
 *
 * dayBounds built the window with Date.UTC, so "the 25th" meant 00:00Z to
 * 23:59Z. For anybody west of Greenwich that is not their 25th. An 8pm Eastern
 * meeting on the 25th happens at 00:00Z on the 26th and fell outside the
 * window entirely; a meeting from the evening of the 24th was counted as
 * theirs. Evening meetings are exactly the ones people ask about afterwards.
 * --------------------------------------------------------------- */
describe("whose day 'the 25th' is", () => {
  const eastern = () =>
    extractExplicitDate("meetings on 2026-08-25", undefined, "America/New_York")!;

  it("starts at midnight Eastern, not midnight UTC", () => {
    /* EDT is UTC-4 in August, so the local day opens at 04:00Z. */
    expect(new Date(eastern().startMs).toISOString()).toBe("2026-08-25T04:00:00.000Z");
  });

  it("includes an 8pm Eastern meeting, which happens the next day in UTC", () => {
    const r = eastern();
    const eightPmEastern = Date.parse("2026-08-26T00:00:00Z");
    expect(eightPmEastern).toBeGreaterThanOrEqual(r.startMs);
    expect(eightPmEastern).toBeLessThanOrEqual(r.endMs);
  });

  it("excludes the evening before, which UTC counted as this day", () => {
    /* 8pm Eastern on the 24th = 00:00Z on the 25th. The UTC window opened
       exactly there and claimed it. */
    const eveningBefore = Date.parse("2026-08-25T00:00:00Z");
    expect(eveningBefore).toBeLessThan(eastern().startMs);
  });

  it("spans a full local day across the DST boundary", () => {
    /* 1 November 2026 is 25 hours long in Eastern. start + 24h would clip an
       hour off the end of it. */
    const r = extractExplicitDate("meetings on 2026-11-01", undefined, "America/New_York")!;
    expect(r.endMs - r.startMs + 1).toBe(25 * 3_600_000);
  });

  it("still reads as UTC when no zone is given", () => {
    const r = extractExplicitDate("meetings on 2026-08-25")!;
    expect(new Date(r.startMs).toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("labels the day in the caller's zone", () => {
    expect(eastern().label).toBe("August 25, 2026");
  });
});
