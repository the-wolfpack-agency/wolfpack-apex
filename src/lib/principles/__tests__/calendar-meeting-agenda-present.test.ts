const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  evaluateCalendarMeetingAgendaPresent,
  hasAgendaMarkers,
} from "@/lib/principles/evaluators/calendar-meeting-agenda-present";

const ORIGINAL_FETCH = global.fetch;
beforeEach(() => mockGetValidToken.mockReset());
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("hasAgendaMarkers", () => {
  test("agenda / topics / outline / numbered list / bullet list trip the marker test", () => {
    expect(hasAgendaMarkers("Agenda: review roadmap")).toBe(true);
    expect(hasAgendaMarkers("Topics for the meeting")).toBe(true);
    expect(hasAgendaMarkers("Goal of this call: align")).toBe(true);
    expect(hasAgendaMarkers("1. Roadmap\n2. Risks")).toBe(true);
    expect(hasAgendaMarkers("- Roadmap\n- Risks")).toBe(true);
  });
  test("body too short or missing markers → false", () => {
    expect(hasAgendaMarkers("Standing weekly sync.")).toBe(false);
    expect(hasAgendaMarkers("")).toBe(false);
    expect(hasAgendaMarkers("Agenda")).toBe(false); // too short
  });
});

describe("evaluateCalendarMeetingAgendaPresent", () => {
  const NOW = Date.parse("2026-05-02T18:00:00Z");
  const ctx = {
    windowStart: "2026-04-25T00:00:00Z",
    windowEnd: "2026-05-02T19:00:00Z",
    subjectUserId: "u1",
  };

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("no token → []", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    expect(await evaluateCalendarMeetingAgendaPresent(ctx)).toEqual([]);
  });

  test("emits +0.3 for upcoming meetings with agenda, -0.3 otherwise; skips past + short + cancelled", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const events = [
      {
        id: "e1",
        subject: "Roadmap review",
        start: { dateTime: "2026-05-03T15:00:00Z" },
        end: { dateTime: "2026-05-03T16:00:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "Agenda: roadmap, risks, asks." },
      },
      {
        id: "e2",
        subject: "Standing sync",
        start: { dateTime: "2026-05-04T15:00:00Z" },
        end: { dateTime: "2026-05-04T15:30:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "Same as last week." },
      },
      {
        id: "e3",
        subject: "Past meeting",
        start: { dateTime: "2026-04-30T15:00:00Z" },
        end: { dateTime: "2026-04-30T16:00:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "Agenda: x" },
      },
      {
        id: "e4",
        subject: "Cancelled",
        isCancelled: true,
        start: { dateTime: "2026-05-05T15:00:00Z" },
        end: { dateTime: "2026-05-05T16:00:00Z" },
        showAs: "busy",
      },
      {
        id: "e5",
        subject: "1-min placeholder",
        start: { dateTime: "2026-05-05T09:00:00Z" },
        end: { dateTime: "2026-05-05T09:01:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "" },
      },
    ];
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ value: events }),
    } as unknown as Response) as unknown as typeof fetch;
    const obs = await evaluateCalendarMeetingAgendaPresent(ctx);
    expect(obs).toHaveLength(2);
    const byId = new Map(obs.map((o) => [o.evidence.sourceId, o]));
    expect(byId.get("e1")?.score).toBe(0.3);
    expect(byId.get("e2")?.score).toBe(-0.3);
  });
});
