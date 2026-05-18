/**
 * calendar_widget tool — intent matching + handler shape.
 *
 * The handler test mocks fetchCalendarEvents so we don't hit Graph,
 * and asserts the WidgetSpec returned has the right discriminator,
 * the events are mapped (with instinctDetailHref injected), and the
 * answer text falls back gracefully on an empty calendar.
 */

const mockFetchCalendarEvents = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: unknown[]) => mockFetchCalendarEvents(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { calendarWidgetTool } from "@/lib/assistant/tools/calendar-widget-tool";

const match = (q: string) => calendarWidgetTool.matchIntent!(q);

const CTX = {
  userId: "u1",
  userRole: "member",
};

beforeEach(() => {
  mockFetchCalendarEvents.mockReset();
  mockTrackEvent.mockReset();
});

describe("calendar_widget intent matching", () => {
  test.each([
    "calendar",
    "Calendar",
    "show me my calendar",
    "show my calendar",
    "open calendar",
    "calendar widget",
    "show calendar",
    "calendar.",
    "calendar?",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "what's on my calendar Monday",
    "any meetings tomorrow",
    "calendar Monday",
    "show me meetings",
    "calendar for next month",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("calendar_widget handler", () => {
  test("returns widget spec with mapped events + analytics fires", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "Demo prep",
        start: "2026-05-16T15:00:00Z",
        end: "2026-05-16T16:00:00Z",
        location: "Zoom",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: true,
        webLink: "https://outlook.office.com/evt-1",
      },
    ]);

    const res = await calendarWidgetTool.handler({ month: "current" }, CTX);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget).toBeDefined();
    expect(res.widget!.kind).toBe("calendar");
    const spec = res.widget as { kind: "calendar"; events: { id: string; instinctDetailHref: string }[] };
    expect(spec.events).toHaveLength(1);
    expect(spec.events[0].id).toBe("evt-1");
    expect(spec.events[0].instinctDetailHref).toBe("/calendar");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "member",
      expect.objectContaining({ widget_kind: "calendar", event_count: 1 }),
    );
  });

  test("graceful fallback when Graph throws — empty events + friendly answer", async () => {
    mockFetchCalendarEvents.mockRejectedValue(new Error("Graph down"));
    const res = await calendarWidgetTool.handler({ month: "current" }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget).toBeDefined();
    const spec = res.widget as { events: unknown[] };
    expect(spec.events).toEqual([]);
    expect(res.answer).toMatch(/No meetings/i);
  });

  test("empty calendar produces 'No meetings' answer", async () => {
    mockFetchCalendarEvents.mockResolvedValue([]);
    const res = await calendarWidgetTool.handler({ month: "current" }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toMatch(/No meetings/i);
  });
});
