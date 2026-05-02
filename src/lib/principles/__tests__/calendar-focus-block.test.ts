/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  computeFocusHoursForDate,
  bucketEventsByDate,
  evaluateCalendarFocusBlock,
} from "@/lib/principles/evaluators/calendar-focus-block";

const ORIG_FETCH = global.fetch;

beforeEach(() => mockGetValidToken.mockReset());
afterEach(() => {
  global.fetch = ORIG_FETCH;
});

const hourMs = (h: number) => h * 60 * 60 * 1000;

describe("computeFocusHoursForDate", () => {
  /* Tests use tz="UTC" so the wall-clock hours in the test inputs are
     unambiguous. The Dallas-tz code path is exercised end-to-end in
     the evaluateCalendarFocusBlock integration tests below. */
  test("an empty calendar = full 8h focus, ratio 1.0", () => {
    const day = new Date("2026-05-04T00:00:00Z"); // Monday
    const out = computeFocusHoursForDate(day, [], "UTC");
    expect(out.focusHours).toBe(8);
    expect(out.ratio).toBe(1);
  });
  test("one 1h meeting at 11am leaves a 2h pre-block + 5h post-block", () => {
    const day = new Date("2026-05-04T00:00:00Z");
    const start = day.getTime() + hourMs(11);
    const end = start + hourMs(1);
    const out = computeFocusHoursForDate(
      day,
      [{ startMs: start, endMs: end }],
      "UTC",
    );
    /* 9–11 (2h focus) + 12–17 (5h focus) = 7h */
    expect(out.focusHours).toBe(7);
  });
  test("a meeting that consumes most of the day leaves 0 ≥2h blocks", () => {
    const day = new Date("2026-05-04T00:00:00Z");
    const out = computeFocusHoursForDate(
      day,
      [
        {
          startMs: day.getTime() + hourMs(10),
          endMs: day.getTime() + hourMs(15),
        },
      ],
      "UTC",
    );
    /* 9–10 (1h) + 15–17 (2h) — only the 2h block counts */
    expect(out.focusHours).toBe(2);
  });
});

describe("bucketEventsByDate", () => {
  test("filters cancelled + free events; buckets by start day", () => {
    const out = bucketEventsByDate([
      {
        id: "a",
        isCancelled: true,
        start: { dateTime: "2026-05-04T10:00:00Z" },
        end: { dateTime: "2026-05-04T11:00:00Z" },
      },
      {
        id: "b",
        showAs: "free",
        start: { dateTime: "2026-05-04T10:00:00Z" },
        end: { dateTime: "2026-05-04T11:00:00Z" },
      },
      {
        id: "c",
        showAs: "busy",
        start: { dateTime: "2026-05-04T10:00:00Z" },
        end: { dateTime: "2026-05-04T11:00:00Z" },
      },
    ]);
    expect(out.size).toBe(1);
    expect(out.get("2026-05-04")).toHaveLength(1);
  });
});

describe("evaluateCalendarFocusBlock", () => {
  test("no token → []", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const out = await evaluateCalendarFocusBlock({
      windowStart: "2026-04-28T00:00:00Z",
      windowEnd: "2026-04-29T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
  test("emits one observation per business day in window", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as any;
    /* Window covering Mon 5/4 → Fri 5/8 = 5 business days. */
    const out = await evaluateCalendarFocusBlock({
      windowStart: "2026-05-04T00:00:00",
      windowEnd: "2026-05-08T23:59:59",
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(5);
    /* Empty calendar = adherence (positive score) on every day. */
    expect(out.every((o) => o.score === 0.5)).toBe(true);
    expect(out.every((o) => o.surface === "calendar")).toBe(true);
    expect(out.every((o) => o.subjectUserId === "u1")).toBe(true);
  });
  test("emits exactly ONE observation per Dallas day even when windowStart is a non-midnight UTC instant", async () => {
    /* Regression for the bug that produced 2 focus_block_ratio rows
       per Dallas day on /principles. The previous loop walked UTC
       instants by +24h from windowStart, which crossed the same
       Dallas day twice when windowStart was offset from UTC midnight. */
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as any;
    const out = await evaluateCalendarFocusBlock({
      /* windowStart at 8:43 UTC mid-week — exactly the shape of a
         real cron firing. Spans Mon 4/27 → Fri 5/1 in Dallas =
         5 business days. */
      windowStart: "2026-04-27T08:43:25Z",
      windowEnd: "2026-05-02T08:43:25Z",
      subjectUserId: "u1",
    });
    /* 5 business days, 1 observation each — no doubles. */
    expect(out).toHaveLength(5);
    /* Every observed_at is unique. */
    const observedAts = out.map((o) => o.observedAt);
    expect(new Set(observedAts).size).toBe(5);
  });

  test("Saturday + Sunday are skipped", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as any;
    /* Window endpoints chosen to land entirely on Sat 5/2 + Sun 5/3
       in DALLAS (CDT, UTC-5): Sat midnight Dallas = 5/2 05:00 UTC;
       Sun-end-of-day Dallas = 5/4 04:59 UTC. */
    const out = await evaluateCalendarFocusBlock({
      windowStart: "2026-05-02T05:00:00Z", // Sat 00:00 Dallas
      windowEnd: "2026-05-04T04:59:59Z", // Sun 23:59 Dallas
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(0);
  });
});
