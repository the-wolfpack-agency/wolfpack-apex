const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  evaluateCalendarMeetingDensity,
  countBusinessMeetings,
  scoreForMeetingCount,
} from "@/lib/principles/evaluators/calendar-meeting-density";

const ORIGINAL_FETCH = global.fetch;
beforeEach(() => mockGetValidToken.mockReset());
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("scoreForMeetingCount", () => {
  test.each([
    [0, 0.4, "lean"],
    [10, 0.4, "lean"],
    [11, 0, "neutral"],
    [15, 0, "neutral"],
    [16, -0.3, "heavy"],
    [20, -0.3, "heavy"],
    [21, -0.6, "saturated"],
    [50, -0.6, "saturated"],
  ])("count=%i → score=%f tier=%s", (count, score, tier) => {
    expect(scoreForMeetingCount(count)).toEqual({ score, tier });
  });
});

describe("countBusinessMeetings", () => {
  test("counts busy 9-17 UTC events; skips cancelled/free/off-hours", () => {
    const events = [
      { showAs: "busy", start: { dateTime: "2026-04-29T10:00:00Z" } },
      { showAs: "busy", start: { dateTime: "2026-04-29T17:00:00Z" } }, // boundary, exclusive at 18
      { showAs: "busy", start: { dateTime: "2026-04-29T08:00:00Z" } }, // pre-9 → skip
      { showAs: "busy", start: { dateTime: "2026-04-29T19:00:00Z" } }, // after 18 → skip
      { showAs: "busy", start: { dateTime: "2026-04-29T13:00:00Z" }, isCancelled: true },
      { showAs: "free", start: { dateTime: "2026-04-29T14:00:00Z" } },
      { showAs: "busy" }, // no start
    ];
    expect(countBusinessMeetings(events)).toBe(2);
  });
});

describe("evaluateCalendarMeetingDensity", () => {
  const ctx = {
    windowStart: "2026-04-25T00:00:00Z",
    windowEnd: "2026-05-02T08:43:25Z",
    subjectUserId: "u1",
  };

  test("no token → []", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    expect(await evaluateCalendarMeetingDensity(ctx)).toEqual([]);
  });

  test("emits one rollup observation with snapped observedAt", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const rows = Array.from({ length: 12 }, (_, i) => ({
      showAs: "busy",
      start: { dateTime: `2026-04-29T1${i % 8}:00:00Z` },
    }));
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ value: rows }),
    } as unknown as Response) as unknown as typeof fetch;
    const obs = await evaluateCalendarMeetingDensity(ctx);
    expect(obs).toHaveLength(1);
    expect(obs[0].surface).toBe("calendar");
    expect(obs[0].surfaceSubtype).toBe("meeting_density");
    expect(obs[0].observedAt).toBe("2026-05-02T00:00:00.000Z");
    /* 12 events all in business hours → neutral tier (11–15) */
    expect(obs[0].score).toBe(0);
    expect(obs[0].evidence.metric).toEqual({ name: "business_meetings", value: 12 });
  });
});
