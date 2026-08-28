/**
 * good_morning_widget tool — intent + handler shape.
 *
 * Same data source as the dashboard panel (generateBriefing); the
 * tool just trims to greeting/schedule/action-items and maps to a
 * WidgetSpec.
 */

const mockGenerateBriefing = jest.fn();
const mockListUpcomingMeetings = jest.fn();
const mockPickDefaultMeeting = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/morning-briefing", () => ({
  generateBriefing: (...a: unknown[]) => mockGenerateBriefing(...a),
}));
jest.mock("@/lib/meetings/upcoming", () => ({
  listUpcomingMeetings: (...a: unknown[]) => mockListUpcomingMeetings(...a),
  pickDefaultMeeting: (...a: unknown[]) => mockPickDefaultMeeting(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { goodMorningWidgetTool } from "@/lib/assistant/tools/good-morning-widget-tool";

const match = (q: string) => goodMorningWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "cto", userEmail: "nick@thewolfpack.agency" };

beforeEach(() => {
  mockGenerateBriefing.mockReset();
  mockListUpcomingMeetings.mockReset();
  mockPickDefaultMeeting.mockReset();
  mockTrackEvent.mockReset();
  /* Default the upcoming-meetings mocks to empty — individual tests
   * override when they care. */
  mockListUpcomingMeetings.mockResolvedValue([]);
  mockPickDefaultMeeting.mockReturnValue(null);
});

describe("good_morning_widget intent matching", () => {
  test.each([
    /* time-of-day-neutral triggers */
    "briefing",
    "Brief me",
    "my brief",
    "my briefing",
    "daily brief",
    "daily briefing",
    "today's briefing",
    "today's agenda",
    "my agenda",
    "my day",
    "what's on for today",
    "whats on today",
    /* time-of-day triggers still work */
    "good morning",
    "good afternoon",
    "good evening",
    "morning",
    "afternoon briefing",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "good morning team",
    "morning meeting",
    "my day looks busy",
    "create a task for the morning briefing",
    "schedule the daily briefing",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("good_morning_widget handler", () => {
  test("maps generateBriefing output into a GoodMorningWidgetSpec", async () => {
    mockGenerateBriefing.mockResolvedValue({
      generatedAt: "2026-05-17T11:00:00Z",
      greeting: "Good morning, Nick",
      summary: "Your calendar is clear today.",
      calendar: {
        eventCount: 1,
        nextEvent: null,
        events: [
          {
            subject: "Jorge traveling: VA - FL",
            startTime: "2026-05-17T20:00:00Z",
            endTime: "2026-05-17T21:00:00Z",
            attendees: ["Jorge", "Alicia", "Ashley"],
            location: "",
          },
        ],
      },
      email: { unreadCount: 0, importantEmails: [] },
      financial: { cashPosition: 0, revenueThisMonth: 0, netProfit: 0, unpaidInvoiceCount: 0, overdueCount: 0, recentPayments: [] },
      clients: { needingAttention: [] },
      team: { activeMembers: 0, recentHighlights: [] },
      actionItems: [
        { priority: "high", text: "Reply to client", context: "from hoxsie", source: "email" },
      ],
    });
    const res = await goodMorningWidgetTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spec = res.widget as { kind: "good_morning"; schedule: { events: unknown[] }; actionItems: unknown[]; connected: boolean };
    expect(spec.kind).toBe("good_morning");
    expect(spec.schedule.events).toHaveLength(1);
    expect(spec.actionItems).toHaveLength(1);
    expect(spec.connected).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({ widget_kind: "good_morning", event_count: 1, action_count: 1 }),
    );
  });

  test("notConnected briefing → connected: false in spec", async () => {
    mockGenerateBriefing.mockResolvedValue({
      generatedAt: "2026-05-17T11:00:00Z",
      greeting: "Good morning",
      summary: "Connect your accounts.",
      calendar: { eventCount: 0, nextEvent: null, events: [] },
      email: { unreadCount: 0, importantEmails: [] },
      financial: { cashPosition: 0, revenueThisMonth: 0, netProfit: 0, unpaidInvoiceCount: 0, overdueCount: 0, recentPayments: [] },
      clients: { needingAttention: [] },
      team: { activeMembers: 0, recentHighlights: [] },
      actionItems: [],
      notConnected: true,
    });
    const res = await goodMorningWidgetTool.handler({}, CTX);
    if (!res.ok) return;
    const spec = res.widget as { connected: boolean };
    expect(spec.connected).toBe(false);
  });

  test("generateBriefing throw → friendly fallback spec", async () => {
    mockGenerateBriefing.mockRejectedValue(new Error("Graph down"));
    const res = await goodMorningWidgetTool.handler({}, CTX);
    if (!res.ok) return;
    const spec = res.widget as { connected: boolean; schedule: { events: unknown[] } };
    expect(spec.connected).toBe(false);
    expect(spec.schedule.events).toEqual([]);
    expect(res.answer).toMatch(/couldn't reach/i);
  });

  test("empty day → 'day's clear' message", async () => {
    mockGenerateBriefing.mockResolvedValue({
      generatedAt: "2026-05-17T11:00:00Z",
      greeting: "Good morning",
      summary: "Clear today.",
      calendar: { eventCount: 0, nextEvent: null, events: [] },
      email: { unreadCount: 0, importantEmails: [] },
      financial: { cashPosition: 0, revenueThisMonth: 0, netProfit: 0, unpaidInvoiceCount: 0, overdueCount: 0, recentPayments: [] },
      clients: { needingAttention: [] },
      team: { activeMembers: 0, recentHighlights: [] },
      actionItems: [],
    });
    const res = await goodMorningWidgetTool.handler({}, CTX);
    if (!res.ok) return;
    expect(res.answer).toMatch(/clear/i);
  });
});

describe("good_morning_widget — meeting pre-brief", () => {
  const STUB_BRIEFING = {
    generatedAt: "2026-05-17T11:00:00Z",
    greeting: "Good afternoon, Nick",
    summary: "Clear afternoon.",
    calendar: { eventCount: 0, nextEvent: null, events: [] },
    email: { unreadCount: 0, importantEmails: [] },
    financial: { cashPosition: 0, revenueThisMonth: 0, netProfit: 0, unpaidInvoiceCount: 0, overdueCount: 0, recentPayments: [] },
    clients: { needingAttention: [] },
    team: { activeMembers: 0, recentHighlights: [] },
    actionItems: [],
  };

  test("bakes upcoming meetings + server-picked default into preBrief", async () => {
    mockGenerateBriefing.mockResolvedValue(STUB_BRIEFING);
    const upcoming = [
      { id: "m1", subject: "Demo prep", start: "2026-05-17T20:00:00Z", end: "2026-05-17T21:00:00Z",
        location: "Zoom", attendees: ["a@x.co"], isOnlineMeeting: true, minutesUntil: 30, inProgress: false },
      { id: "m2", subject: "1:1 with Hoxsie", start: "2026-05-18T15:00:00Z", end: "2026-05-18T15:30:00Z",
        location: "", attendees: ["b@x.co", "c@x.co"], isOnlineMeeting: false, minutesUntil: 1200, inProgress: false },
    ];
    mockListUpcomingMeetings.mockResolvedValue(upcoming);
    mockPickDefaultMeeting.mockReturnValue(upcoming[0]);

    const res = await goodMorningWidgetTool.handler({}, CTX);
    if (!res.ok) throw new Error("expected ok");
    const spec = res.widget as { preBrief?: { meetings: unknown[]; defaultMeetingId: string | null; lookaheadHours: number } };
    expect(spec.preBrief).toBeDefined();
    expect(spec.preBrief?.meetings).toHaveLength(2);
    expect(spec.preBrief?.defaultMeetingId).toBe("m1");
    expect(spec.preBrief?.lookaheadHours).toBe(48);
    expect(res.answer).toMatch(/Demo prep/);
  });

  test("no upcoming meetings → preBrief with empty list + null default", async () => {
    mockGenerateBriefing.mockResolvedValue(STUB_BRIEFING);
    mockListUpcomingMeetings.mockResolvedValue([]);
    mockPickDefaultMeeting.mockReturnValue(null);
    const res = await goodMorningWidgetTool.handler({}, CTX);
    if (!res.ok) throw new Error("expected ok");
    const spec = res.widget as { preBrief?: { meetings: unknown[]; defaultMeetingId: string | null } };
    expect(spec.preBrief?.meetings).toEqual([]);
    expect(spec.preBrief?.defaultMeetingId).toBeNull();
  });

  test("upcoming fetch failure does not break the briefing — empty preBrief", async () => {
    mockGenerateBriefing.mockResolvedValue(STUB_BRIEFING);
    mockListUpcomingMeetings.mockRejectedValue(new Error("Graph 503"));
    mockPickDefaultMeeting.mockReturnValue(null);
    const res = await goodMorningWidgetTool.handler({}, CTX);
    if (!res.ok) throw new Error("expected ok");
    const spec = res.widget as { preBrief?: { meetings: unknown[] }; connected: boolean };
    expect(spec.preBrief?.meetings).toEqual([]);
    expect(spec.connected).toBe(true); // briefing itself still resolved
  });

  test("analytics include prebrief_count", async () => {
    mockGenerateBriefing.mockResolvedValue(STUB_BRIEFING);
    mockListUpcomingMeetings.mockResolvedValue([
      { id: "m1", subject: "x", start: "2026-05-17T20:00:00Z", end: "2026-05-17T21:00:00Z",
        location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 1, inProgress: false },
    ]);
    mockPickDefaultMeeting.mockReturnValue(null);
    await goodMorningWidgetTool.handler({}, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({ prebrief_count: 1 }),
    );
  });
});

/**
 * "plan my day" belongs here, not in plan_my_day.
 *
 * A routing audit on 2026-08-26 found "plan my day", "run my day" and "what
 * should I work on" reaching no tool at all: the literal name of a feature,
 * unreachable.
 *
 * plan_my_day is not their home. It takes a DESCRIBED day and says which steps
 * the product can already do, so it requires forty characters of description
 * and a bare command has none. What somebody typing "plan my day" wants is
 * what this widget already assembles: today's meetings and what needs doing.
 */
describe("the day commands", () => {
  it.each([
    "plan my day",
    "run my day",
    "what should I work on",
    "what should I do today",
  ])("claims %s", (prompt) => {
    expect(goodMorningWidgetTool.matchIntent!(prompt)).not.toBeNull();
  });

  /* The pattern is anchored, so a day command with an object is somebody
     asking about a specific thing rather than for their briefing. */
  /* Reserved for a chain runner by client-prompt-corpus: starting a chain is
     not the same as being shown one. */
  it("leaves start my day to the chain runner", () => {
    expect(goodMorningWidgetTool.matchIntent!("start my day")).toBeNull();
  });

  it.each([
    "plan my week with the client",
    "what should I do about the invoice",
    "run my report",
  ])("leaves %s alone", (prompt) => {
    expect(goodMorningWidgetTool.matchIntent!(prompt)).toBeNull();
  });

  it("still claims the original phrasings", () => {
    expect(goodMorningWidgetTool.matchIntent!("good morning")).not.toBeNull();
    expect(goodMorningWidgetTool.matchIntent!("brief me")).not.toBeNull();
  });
});

/**
 * Two sources, and they can disagree.
 *
 * eventCount comes from the briefing's own Graph fetch. defaultMeeting comes
 * from listUpcomingMeetings, a separate call over a separate window. When the
 * first fails it yields an empty list, and the sentence became "0 meetings
 * today, 0 action items, next: Lunch with Cedar & Stone", which contradicts
 * itself in eleven words.
 *
 * Observed on production 2026-08-28, in the same conversation where the
 * calendar tool reported six meetings for the same day.
 */
describe("when the two calendar sources disagree", () => {
  const emptyBriefing = {
    generatedAt: "2026-08-28T11:00:00Z",
    greeting: "Good morning",
    summary: "",
    calendar: { eventCount: 0, nextEvent: null, events: [] },
    email: { unreadCount: 0, importantEmails: [] },
    actionItems: [],
    notConnected: false,
  };

  const meeting = {
    id: "m1",
    subject: "Lunch — Cedar & Stone Partnership",
    start: "2026-08-28T12:30:00Z",
    end: "2026-08-28T13:30:00Z",
    attendees: [],
    isOnlineMeeting: false,
    minutesUntil: 90,
    inProgress: false,
  };

  /* A count of zero next to a named meeting is not a quiet day, it is a
     failed read, and this is the one place both facts are in scope. */
  it("does not claim zero meetings while naming the next one", async () => {
    mockGenerateBriefing.mockResolvedValue(emptyBriefing);
    mockListUpcomingMeetings.mockResolvedValue([meeting]);
    mockPickDefaultMeeting.mockReturnValue(meeting);

    const r = await goodMorningWidgetTool.handler({}, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.answer).not.toMatch(/^0 meetings/);
    expect(r.answer).toMatch(/could not read your full schedule/i);
    expect(r.answer).toContain("Lunch — Cedar & Stone Partnership");
  });

  /* A genuinely clear day still reads as a clear day. The fix must not turn
     every quiet morning into a scary message about a failed read. */
  it("still says the day is clear when nothing is scheduled anywhere", async () => {
    mockGenerateBriefing.mockResolvedValue(emptyBriefing);
    mockListUpcomingMeetings.mockResolvedValue([]);
    mockPickDefaultMeeting.mockReturnValue(null);

    const r = await goodMorningWidgetTool.handler({}, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/day's clear/i);
  });

  /* When the count is real, it is reported, next meeting and all. */
  it("reports the count when the sources agree", async () => {
    mockGenerateBriefing.mockResolvedValue({
      ...emptyBriefing,
      calendar: {
        eventCount: 2,
        nextEvent: null,
        events: [
          { subject: "Standup", startTime: "2026-08-28T10:00:00Z", endTime: "2026-08-28T10:15:00Z", attendees: [] },
          { subject: "Review", startTime: "2026-08-28T14:00:00Z", endTime: "2026-08-28T15:00:00Z", attendees: [] },
        ],
      },
    });
    mockListUpcomingMeetings.mockResolvedValue([meeting]);
    mockPickDefaultMeeting.mockReturnValue(meeting);

    const r = await goodMorningWidgetTool.handler({}, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/^2 meetings today/);
    expect(r.answer).toContain("next: Lunch");
  });
});
