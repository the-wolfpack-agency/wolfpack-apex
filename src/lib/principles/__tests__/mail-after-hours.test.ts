 
const mockGetValidToken = jest.fn();
/* The evaluator now goes through getReadTokenForUser (which falls
   back to delegated when app-only is off — today's behavior). The
   mock returns a delegated-shaped ReadToken so existing tests stay
   valid. We re-export graphPathForReadToken from the real module since
   it's pure and doesn't hit the network. */
const { graphPathForReadToken: realGraphPath } = jest.requireActual(
  "@/lib/microsoft-graph",
);
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
  getReadTokenForUser: async (userId: string) => {
    const t = await mockGetValidToken(userId);
    if (!t) return null;
    return { accessToken: t.accessToken, isAppOnly: false, userPath: null };
  },
  graphPathForReadToken: (...a: any[]) => realGraphPath(...a),
}));

import {
  evaluateMailAfterHours,
  isAfterHours,
  localHourInTz,
} from "@/lib/principles/evaluators/mail-after-hours";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("isAfterHours", () => {
  test("default 21..7 covers night and morning hours", () => {
    expect(isAfterHours(22)).toBe(true);
    expect(isAfterHours(5)).toBe(true);
    expect(isAfterHours(21)).toBe(true);
    expect(isAfterHours(7)).toBe(false);
    expect(isAfterHours(12)).toBe(false);
    expect(isAfterHours(20)).toBe(false);
  });
  test("custom non-wraparound window (10..14)", () => {
    expect(isAfterHours(11, 10, 14)).toBe(true);
    expect(isAfterHours(15, 10, 14)).toBe(false);
  });
  test("equal start/end is never after-hours (no-op window)", () => {
    expect(isAfterHours(5, 0, 0)).toBe(false);
  });
});

describe("localHourInTz", () => {
  test("converts a UTC ISO to the named tz hour", () => {
    /* 2026-05-01T03:30:00Z → 23:30 the previous day at America/New_York. */
    expect(localHourInTz("2026-05-01T03:30:00Z", "America/New_York")).toBe(23);
  });
  test("falls back to UTC on invalid tz", () => {
    expect(
      localHourInTz("2026-05-01T03:30:00Z", "Not/A_Real_Zone"),
    ).toBe(3);
  });
});

describe("evaluateMailAfterHours", () => {
  test("returns [] when no token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const out = await evaluateMailAfterHours({
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-05-01T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
  test("returns [] when subjectUserId missing", async () => {
    const out = await evaluateMailAfterHours({
      windowStart: "x",
      windowEnd: "y",
    });
    expect(out).toEqual([]);
  });
  test("emits one Observation per after-hours send", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    /* First fetch = mailboxSettings; second = sentitems list. */
    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            workingHours: { timeZone: { name: "America/New_York" } },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "m1",
              sentDateTime: "2026-05-01T03:30:00Z", // 23:30 EDT — after hours
              subject: "Late thought",
              webLink: "https://outlook/m/1",
            },
            {
              id: "m2",
              sentDateTime: "2026-05-01T15:00:00Z", // 11am EDT — business hours
              subject: "Normal time",
            },
          ],
        }),
      };
    }) as any;

    const out = await evaluateMailAfterHours({
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-05-01T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(1);
    expect(out[0].surface).toBe("mail");
    expect(out[0].surfaceSubtype).toBe("outlook_send_after_hours");
    expect(out[0].subjectUserId).toBe("u1");
    expect(out[0].score).toBe(-0.6);
    expect(out[0].evidence.kind).toBe("outlook_send_after_hours");
    expect(out[0].evidence.sourceId).toBe("m1");
    expect(out[0].evidence.metric?.value).toBe(23);
  });
  test("graph 5xx on sent list returns [] (no throw, no observations)", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }) as any;
    const out = await evaluateMailAfterHours({
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-05-01T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
  test("missing mailbox tz falls back to ORG_TZ (Dallas) and still detects after-hours", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "m1",
              /* In CDT (May 2026, UTC-5): UTC 03:30 = Dallas 22:30
                 (10:30pm) — solidly inside the 21:00-07:00 after-hours
                 window. Confirms the org-tz fallback works without
                 mailbox settings. */
              sentDateTime: "2026-05-01T03:30:00Z",
            },
          ],
        }),
      };
    }) as any;
    const out = await evaluateMailAfterHours({
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-05-02T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(1);
  });
});
