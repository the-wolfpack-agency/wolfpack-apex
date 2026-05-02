const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  evaluateCalendarDeclinedAttendance,
  scoreForDeclinedCount,
} from "@/lib/principles/evaluators/calendar-declined-attendance";

const ORIGINAL_FETCH = global.fetch;
beforeEach(() => mockGetValidToken.mockReset());
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("scoreForDeclinedCount", () => {
  test.each([
    [0, 0.3],
    [1, 0],
    [2, 0],
    [3, -0.3],
    [5, -0.3],
    [6, -0.6],
    [50, -0.6],
  ])("count=%i → score=%f", (count, expected) => {
    expect(scoreForDeclinedCount(count)).toBe(expected);
  });
});

describe("evaluateCalendarDeclinedAttendance", () => {
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
    expect(await evaluateCalendarDeclinedAttendance(ctx)).toEqual([]);
  });

  test("counts declined + tentative on past events; ignores future + cancelled", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const events = [
      {
        id: "e1",
        subject: "Ghost A",
        start: { dateTime: "2026-04-29T10:00:00Z" },
        end: { dateTime: "2026-04-29T11:00:00Z" },
        showAs: "busy",
        responseStatus: { response: "declined" },
      },
      {
        id: "e2",
        subject: "Ghost B",
        start: { dateTime: "2026-04-30T10:00:00Z" },
        end: { dateTime: "2026-04-30T11:00:00Z" },
        showAs: "tentative",
        responseStatus: { response: "tentativelyAccepted" },
      },
      {
        id: "e3",
        subject: "Real meeting",
        start: { dateTime: "2026-04-29T15:00:00Z" },
        end: { dateTime: "2026-04-29T16:00:00Z" },
        showAs: "busy",
        responseStatus: { response: "accepted" },
      },
      {
        id: "e4",
        subject: "Future declined",
        start: { dateTime: "2026-05-05T10:00:00Z" },
        end: { dateTime: "2026-05-05T11:00:00Z" },
        showAs: "busy",
        responseStatus: { response: "declined" },
      },
      {
        id: "e5",
        subject: "Cancelled",
        start: { dateTime: "2026-04-29T12:00:00Z" },
        end: { dateTime: "2026-04-29T13:00:00Z" },
        isCancelled: true,
        responseStatus: { response: "declined" },
      },
    ];
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ value: events }),
    } as unknown as Response) as unknown as typeof fetch;
    const obs = await evaluateCalendarDeclinedAttendance(ctx);
    expect(obs).toHaveLength(1);
    expect(obs[0].surfaceSubtype).toBe("declined_attendance_rate");
    expect(obs[0].observedAt).toBe("2026-05-02T00:00:00.000Z");
    /* 2 ghosts → score 0 (1–2 tier) */
    expect(obs[0].score).toBe(0);
    expect(obs[0].evidence.metric).toEqual({ name: "ghost_meetings", value: 2 });
    expect(obs[0].evidence.notes).toContain("Ghost A");
    expect(obs[0].evidence.notes).toContain("Ghost B");
  });
});
