const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  buildSeriesRollups,
  scoreSeries,
  evaluateCalendarRecurringMeetingDrift,
} from "@/lib/principles/evaluators/calendar-recurring-meeting-drift";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("buildSeriesRollups", () => {
  test("groups events by seriesMasterId, ignores cancelled / non-busy / non-recurring", () => {
    const events = [
      { id: "e1", subject: "Standup", seriesMasterId: "S1", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-25T10:00:00Z" } },
      { id: "e2", subject: "Standup", seriesMasterId: "S1", showAs: "busy", body: { content: "Decisions: ship Friday." }, start: { dateTime: "2026-04-26T10:00:00Z" } },
      { id: "e3", subject: "Standup", seriesMasterId: "S1", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-27T10:00:00Z" } },
      { id: "e4", subject: "Cancelled", seriesMasterId: "S1", isCancelled: true, showAs: "busy" },
      { id: "e5", subject: "Free", seriesMasterId: "S1", showAs: "free" },
      { id: "e6", subject: "One-off", showAs: "busy", body: { content: "" } /* no seriesMasterId */ },
    ];
    const rollups = buildSeriesRollups(events);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].seriesId).toBe("S1");
    expect(rollups[0].instances).toBe(3);
    expect(rollups[0].withOutcome).toBe(1);
  });
});

describe("scoreSeries", () => {
  test("< 3 instances → skipped, score 0", () => {
    expect(scoreSeries({ seriesId: "S", subject: "x", instances: 2, withOutcome: 0, firstStart: null, lastWebLink: null })).toEqual({
      score: 0,
      tier: "skipped",
    });
  });
  test("≥ 3 instances + ≥ 50% with outcome → with_discipline (+0.2)", () => {
    expect(scoreSeries({ seriesId: "S", subject: "x", instances: 4, withOutcome: 2, firstStart: null, lastWebLink: null })).toEqual({
      score: 0.2,
      tier: "with_discipline",
    });
  });
  test("≥ 3 instances + < 50% with outcome → drift (-0.4)", () => {
    expect(scoreSeries({ seriesId: "S", subject: "x", instances: 4, withOutcome: 1, firstStart: null, lastWebLink: null })).toEqual({
      score: -0.4,
      tier: "drift",
    });
  });
});

describe("evaluateCalendarRecurringMeetingDrift", () => {
  const ctx = {
    windowStart: "2026-04-25T00:00:00Z",
    windowEnd: "2026-05-02T00:00:00Z",
    subjectUserId: "u1",
  };

  test("no token → []", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    expect(await evaluateCalendarRecurringMeetingDrift(ctx)).toEqual([]);
  });

  test("emits one observation per drifting series, skips < 3-instance series", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const events = [
      { id: "a1", subject: "Drifting standup", seriesMasterId: "S_drift", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-25T09:00:00Z" } },
      { id: "a2", subject: "Drifting standup", seriesMasterId: "S_drift", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-26T09:00:00Z" } },
      { id: "a3", subject: "Drifting standup", seriesMasterId: "S_drift", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-27T09:00:00Z" } },
      { id: "b1", subject: "Two-event series", seriesMasterId: "S_skip", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-25T11:00:00Z" } },
      { id: "b2", subject: "Two-event series", seriesMasterId: "S_skip", showAs: "busy", body: { content: "" }, start: { dateTime: "2026-04-26T11:00:00Z" } },
    ];
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ value: events }),
    } as unknown as Response) as unknown as typeof fetch;

    const obs = await evaluateCalendarRecurringMeetingDrift(ctx);
    expect(obs).toHaveLength(1);
    expect(obs[0].surface).toBe("calendar");
    expect(obs[0].surfaceSubtype).toBe("recurring_meeting_drift");
    expect(obs[0].score).toBe(-0.4);
    expect(obs[0].evidence.metric).toEqual({ name: "instances", value: 3 });
    expect(obs[0].evidence.notes).toContain("drift");
  });
});
