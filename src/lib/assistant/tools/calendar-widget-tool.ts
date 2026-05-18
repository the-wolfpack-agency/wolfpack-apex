/**
 * calendar_widget — renders a mini calendar grid in the chat.
 *
 * Trigger phrases:
 *   "calendar"  /  "show me my calendar"  /  "open calendar"
 *   "calendar widget"  /  "show calendar"
 *
 * The bare-day-of-week and "any meetings X" phrases go to the existing
 * meetings/calendar lookup tools — this widget tool catches the
 * "show me the whole thing" intent. Returns events for the current
 * month so the renderer can render dots on busy days.
 *
 * Tradeoffs documented:
 *   - We fetch a full month at request time. Could be lazy (month-by-
 *     month), but month-at-a-time is small (typically <100 events)
 *     and one fetch beats per-day round trips.
 *   - We anchor on the CURRENT month. Future ask: support "next month"
 *     etc. Today the renderer has prev/next buttons but they ask the
 *     assistant again rather than navigate locally.
 */

import { z } from "zod";
import { fetchCalendarEvents } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { CalendarWidgetSpec, CalendarWidgetEvent } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  /** ISO date of the 1st of the requested month, or "current" to use now. */
  month: z.string().default("current"),
});
type Params = z.infer<typeof ParamSchema>;

interface CalendarWidgetData {
  kind: "calendar";
  eventCount: number;
}

const INTENT_RE =
  /^(?:calendar|show\s+(?:me\s+)?(?:my\s+)?calendar|open\s+calendar|calendar\s+widget|show\s+calendar)[\s.?!]*$/i;

function matchCalendarWidgetIntent(message: string): Params | null {
  const trimmed = message.trim();
  if (!INTENT_RE.test(trimmed)) return null;
  return { month: "current" };
}

/** Compute the UTC ISO timestamp for the 1st of the given month at 00:00,
 *  and the 1st of the next month at 00:00. Inclusive start, exclusive end. */
function monthBounds(anchor: Date): { firstOfMonth: string; firstOfNextMonth: string } {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return {
    firstOfMonth: start.toISOString(),
    firstOfNextMonth: end.toISOString(),
  };
}

export const calendarWidgetTool: ToolDef<Params, CalendarWidgetData> = {
  name: "calendar_widget",
  description:
    "Render a mini calendar grid in the chat with the user's events for the current month. Click a day to see its meetings.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchCalendarWidgetIntent,
  async handler(_params, ctx): Promise<ToolResult<CalendarWidgetData>> {
    const anchor = new Date();
    const { firstOfMonth, firstOfNextMonth } = monthBounds(anchor);

    let events: CalendarWidgetEvent[] = [];
    try {
      const rawEvents = await fetchCalendarEvents(ctx.userId, firstOfMonth, firstOfNextMonth);
      events = rawEvents.map((e) => ({
        id: e.id,
        subject: e.subject,
        start: e.start,
        end: e.end,
        location: e.location || undefined,
        isOnlineMeeting: e.isOnlineMeeting,
        webLink: e.webLink ?? null,
        /* No per-event detail route exists yet, so the in-app deep
         * link points to /calendar (the month view that shows the
         * event in context). Drop this when an event-detail page
         * lands; the renderer only renders the link when set. */
        instinctDetailHref: "/calendar",
      }));
    } catch (err) {
      /* Calendar fetch fails should not break the widget; return an
       * empty calendar with a clear answer instead of throwing. */
      console.warn("[calendar-widget] fetchCalendarEvents failed:", (err as Error).message);
    }

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "calendar",
      event_count: events.length,
      month: firstOfMonth,
    });

    const spec: CalendarWidgetSpec = {
      kind: "calendar",
      month: firstOfMonth,
      rangeStart: firstOfMonth,
      rangeEnd: firstOfNextMonth,
      events,
      title: "Your calendar",
    };

    const monthLabel = anchor.toLocaleString("default", { month: "long", year: "numeric" });
    const answer =
      events.length === 0
        ? `No meetings in ${monthLabel}. The calendar below lets you click out to specific days when events appear.`
        : `Here's your calendar for ${monthLabel} (${events.length} event${events.length === 1 ? "" : "s"}). Click a day to expand the meetings.`;

    return {
      ok: true,
      data: { kind: "calendar", eventCount: events.length },
      answer,
      widget: spec,
    };
  },
};

registerTool(calendarWidgetTool);
