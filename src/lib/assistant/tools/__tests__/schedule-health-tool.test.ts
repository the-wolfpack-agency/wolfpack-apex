/**
 * The assistant path into the schedule analysis.
 *
 * The engine is tested next door. What matters here is that people
 * reach it in the words they would actually use, that the window they
 * asked for is the window analysed, and that nothing from inside a
 * calendar leaks into analytics.
 */

export {};

const mockList = jest.fn();
jest.mock("@/lib/integrations/microsoft-calendar", () => ({
  listEvents: (...a: any[]) => mockList(...a),
}));

const mockSettings = jest.fn();
jest.mock("@/lib/integrations/microsoft-mailbox", () => ({
  getOwnMailboxSettings: (...a: any[]) => mockSettings(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrack(...a) }));

const CTX: any = { userId: "u1", userRole: "admin", workspaceId: "w1" };

function evt(dayOffset: number, hour: number, mins: number, subject: string) {
  const start = new Date(2026, 7, 24 + dayOffset, hour, 0, 0, 0);
  return {
    subject,
    start: start.toISOString(),
    end: new Date(start.getTime() + mins * 60_000).toISOString(),
    attendees: ["a@x.com", "b@x.com"],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.mockResolvedValue({ timeZone: "America/Detroit" });
});

async function tool() {
  return (await import("../schedule-health-tool")).scheduleHealthTool;
}

describe("people reach it in their own words", () => {
  it.each([
    "where are meetings doing more harm than good",
    "analyse my calendar",
    "what are my ideal times of day",
    "when should I do focus work",
    "where is my week going",
    "schedule health",
  ])("matches %p", async (phrase) => {
    expect((await tool()).matchIntent!(phrase)).not.toBeNull();
  });

  it("does not fire on an ordinary calendar question", async () => {
    const t = await tool();
    expect(t.matchIntent!("what's on my calendar today")).toBeNull();
    expect(t.matchIntent!("book a meeting with Dana")).toBeNull();
  });

  it("takes the window from the question when one is given", async () => {
    const t = await tool();
    expect(t.matchIntent!("analyse my calendar for the last 30 days")?.days).toBe(30);
    expect(t.matchIntent!("review my schedule over the past 4 weeks")?.days).toBe(28);
    expect(t.matchIntent!("analyse my calendar for the quarter")?.days).toBe(90);
    /* Two weeks when nobody said: one week is too noisy to generalise
       from, a quarter buries a change that just started. */
    expect(t.matchIntent!("analyse my calendar")?.days).toBe(14);
  });

  it("looks forward when the question is about what is committed", async () => {
    const t = await tool();
    expect(t.matchIntent!("analyse my schedule for the coming month")?.direction).toBe("ahead");
    expect(t.matchIntent!("analyse my calendar")?.direction).toBe("past");
  });
});

describe("it analyses the window it was asked for", () => {
  it("looks backwards for the past and forwards for ahead", async () => {
    mockList.mockResolvedValue([]);
    const t = await tool();
    const now = Date.now();

    await t.handler({ days: 14, direction: "past" }, CTX);
    const past = mockList.mock.calls[0][1];
    expect(new Date(past.from).getTime()).toBeLessThan(now);
    expect(new Date(past.to).getTime()).toBeLessThanOrEqual(now + 1000);

    await t.handler({ days: 14, direction: "ahead" }, CTX);
    const ahead = mockList.mock.calls[1][1];
    expect(new Date(ahead.to).getTime()).toBeGreaterThan(now);
  });

  it("answers rather than failing when the calendar is empty", async () => {
    mockList.mockResolvedValue([]);
    const t = await tool();
    const res: any = await t.handler({ days: 14, direction: "past" }, CTX);
    expect(res.ok).toBe(true);
    expect(res.answer).toContain("nothing here to improve");
  });

  it("reads the briefing's startTime shape as well as Graph's start", async () => {
    /* Two event shapes exist in this codebase. Being tied to one of
       them would make the analysis silently empty for half its
       possible callers. */
    const s = new Date(2026, 7, 24, 10, 0, 0, 0);
    mockList.mockResolvedValue([
      { subject: "Legacy shape", startTime: s.toISOString(), endTime: new Date(s.getTime() + 3_600_000).toISOString() },
    ]);
    const t = await tool();
    const res: any = await t.handler({ days: 14, direction: "past" }, CTX);
    expect(res.data.meetings).toBe(1);
  });

  it("survives an attendee list of objects rather than strings", async () => {
    const s = new Date(2026, 7, 24, 10, 0, 0, 0);
    mockList.mockResolvedValue([
      {
        subject: "Object attendees",
        start: s.toISOString(),
        end: new Date(s.getTime() + 3_600_000).toISOString(),
        attendees: [{ name: "Dana" }, { name: "Ray" }],
      },
    ]);
    const t = await tool();
    const res: any = await t.handler({ days: 14, direction: "past" }, CTX);
    expect(res.ok).toBe(true);
    expect(res.data.meetings).toBe(1);
  });
});

describe("what reaches analytics", () => {
  it("records the shape of the week and nothing that was in it", async () => {
    /* What is in somebody's calendar is among the most sensitive data
       we hold, and none of it is needed to learn whether this analysis
       is worth keeping. */
    mockList.mockResolvedValue([
      evt(0, 9, 60, "Acquisition talks with Ackerman Motor Group"),
      evt(0, 10, 60, "1:1 Dana"),
    ]);
    const t = await tool();
    await t.handler({ days: 14, direction: "past" }, CTX);

    const [event, , , meta] = mockTrack.mock.calls[0];
    expect(event).toBe("assistant.schedule_analysed");
    expect(meta).toMatchObject({ days: 14, meetings: 2 });
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("Ackerman");
    expect(serialized).not.toContain("Dana");
  });
});

describe("it asks whose day it is analysing", () => {
  it("uses the person's mailbox timezone, not the server's", async () => {
    /* On Vercel the server is UTC. A Detroit dealer told to defend UTC
       afternoons acts on it once and never opens the tool again. */
    mockSettings.mockResolvedValue({ timeZone: "America/Detroit" });
    mockList.mockResolvedValue([
      { subject: "Morning", start: "2026-08-24T13:00:00.000Z", end: "2026-08-24T14:00:00.000Z" },
    ]);
    const t = await tool();
    const res: any = await t.handler({ days: 14, direction: "past" }, CTX);
    expect(mockSettings).toHaveBeenCalledWith("u1");
    expect(res.answer).toContain("times in America/Detroit");
  });

  it("still answers when the settings call fails, and says it fell back", async () => {
    /* Refusing to report because a settings lookup failed would be
       worse than reporting in UTC and saying so. */
    mockSettings.mockRejectedValue(new Error("scope missing"));
    mockList.mockResolvedValue([
      { subject: "Morning", start: "2026-08-24T13:00:00.000Z", end: "2026-08-24T14:00:00.000Z" },
    ]);
    const t = await tool();
    const res: any = await t.handler({ days: 14, direction: "past" }, CTX);
    expect(res.ok).toBe(true);
    expect(res.answer).toContain("times in UTC");
  });

  it("records the zone, because every other number depends on it", async () => {
    mockList.mockResolvedValue([
      { subject: "Morning", start: "2026-08-24T13:00:00.000Z", end: "2026-08-24T14:00:00.000Z" },
    ]);
    const t = await tool();
    await t.handler({ days: 14, direction: "past" }, CTX);
    expect(mockTrack.mock.calls[0][3]).toMatchObject({ time_zone: "America/Detroit" });
  });
});
