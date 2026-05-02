const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  evaluateCalendarMeetingOutcomeLogged,
  extractMeaningfulBody,
  hasOutcomeMarkers,
  scoreOutcome,
} from "@/lib/principles/evaluators/calendar-meeting-outcome-logged";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("extractMeaningfulBody", () => {
  test("strips HTML tags + entities", () => {
    expect(extractMeaningfulBody("<p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
  });
  test("strips Teams join boilerplate + meeting id", () => {
    const body =
      "Join the meeting now https://teams.microsoft.com/x Meeting ID: 123 Passcode: abc";
    expect(extractMeaningfulBody(body)).toBe("");
  });
  test("preserves real notes after stripping boilerplate", () => {
    const body =
      "<p>Decisions:</p><ul><li>Ship Friday</li></ul>https://teams.microsoft.com/x Meeting ID: 1";
    const out = extractMeaningfulBody(body);
    expect(out).toContain("Decisions");
    expect(out).toContain("Ship Friday");
    expect(out).not.toContain("Meeting ID");
  });
  test("undefined → empty", () => {
    expect(extractMeaningfulBody(undefined)).toBe("");
  });
});

describe("scoreOutcome (tiering)", () => {
  test("body with outcome markers → +0.3 logged", () => {
    expect(scoreOutcome("Decisions: ship Friday. Action: deploy.")).toEqual({
      score: 0.3,
      tier: "logged",
    });
  });
  test("substantial body (≥150 chars) without markers → 0 neutral (rich agenda, no recap)", () => {
    const body = "x".repeat(200);
    expect(scoreOutcome(body)).toEqual({ score: 0, tier: "neutral" });
  });
  test("short body without markers → -0.3 missed", () => {
    expect(scoreOutcome("Standing weekly sync.")).toEqual({
      score: -0.3,
      tier: "missed",
    });
  });
  test("empty body → -0.3 missed", () => {
    expect(scoreOutcome("")).toEqual({ score: -0.3, tier: "missed" });
  });
});

describe("hasOutcomeMarkers", () => {
  test("decisions/action items/next steps trip the marker test", () => {
    expect(hasOutcomeMarkers("Decisions: ship by Friday.")).toBe(true);
    expect(hasOutcomeMarkers("Action items assigned to Nick.")).toBe(true);
    expect(hasOutcomeMarkers("Next steps: write the doc.")).toBe(true);
  });
  test("invite-only / agenda-less body does not trip", () => {
    expect(hasOutcomeMarkers("Standing weekly sync.")).toBe(false);
    expect(hasOutcomeMarkers("")).toBe(false);
  });
  test("very short bodies are not enough even with a marker word", () => {
    expect(hasOutcomeMarkers("Due")).toBe(false);
  });
});

describe("evaluateCalendarMeetingOutcomeLogged", () => {
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
    expect(await evaluateCalendarMeetingOutcomeLogged(ctx)).toEqual([]);
  });

  test("emits +0.3 for past meetings with outcome notes, -0.3 otherwise", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const events = [
      {
        id: "e1",
        subject: "Sprint review",
        start: { dateTime: "2026-04-29T15:00:00Z" },
        end: { dateTime: "2026-04-29T16:00:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "Decisions: ship Friday. Action items: deploy." },
      },
      {
        id: "e2",
        subject: "Standup",
        start: { dateTime: "2026-04-30T15:00:00Z" },
        end: { dateTime: "2026-04-30T15:15:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "Standing weekly sync." },
      },
      {
        id: "e3",
        subject: "Future event",
        start: { dateTime: "2026-05-05T15:00:00Z" },
        end: { dateTime: "2026-05-05T16:00:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "" },
      },
      {
        id: "e4",
        subject: "Cancelled mtg",
        start: { dateTime: "2026-04-29T12:00:00Z" },
        end: { dateTime: "2026-04-29T13:00:00Z" },
        isCancelled: true,
        showAs: "busy",
      },
      {
        id: "e5",
        subject: "1-min placeholder",
        start: { dateTime: "2026-04-30T09:00:00Z" },
        end: { dateTime: "2026-04-30T09:01:00Z" },
        showAs: "busy",
        body: { contentType: "text", content: "" },
      },
    ];
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ value: events }),
    } as unknown as Response) as unknown as typeof fetch;

    const obs = await evaluateCalendarMeetingOutcomeLogged(ctx);
    /* e3 is future, e4 cancelled, e5 is < 5 min — only e1 + e2 emit. */
    expect(obs).toHaveLength(2);
    const byId = new Map(obs.map((o) => [o.evidence.sourceId, o]));
    expect(byId.get("e1")?.score).toBe(0.3);
    expect(byId.get("e2")?.score).toBe(-0.3);
  });
});
