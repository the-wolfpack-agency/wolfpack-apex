/**
 * Chat widgets: interactive surfaces the Assistant can return inside
 * the chat, instead of (or alongside) free-text answers.
 *
 * Architecture:
 *   - A tool returns a `widget: WidgetSpec` in its ToolSuccess result.
 *   - The widget flows through AssistantResponse → API JSON → Message
 *     → InstinctChat, where ChatWidget dispatches to the right
 *     renderer based on the `kind` discriminator.
 *   - Each renderer is a self-contained React component that owns its
 *     own state, hover/click handlers, and any follow-up navigation.
 *
 * Why a generic framework instead of one-off components:
 *   - Future widgets (email thread, task list, dashboard chart) plug
 *     into the same plumbing — one new `kind` value + one new renderer.
 *   - Persistence is uniform: the widget spec rides in message
 *     metadata so reloads restore the widget on historical messages.
 *   - Analytics is uniform: every widget surface emits the same
 *     `assistant.widget_rendered` event with its kind, so the
 *     learning loop sees which interactive surfaces get used.
 */

export interface CalendarWidgetEvent {
  id: string;
  subject: string;
  /** ISO timestamps for start and end. */
  start: string;
  end: string;
  location?: string;
  organizer?: string;
  isOnlineMeeting?: boolean;
  /** Outlook web link to open the event in Outlook (when available). */
  webLink?: string | null;
  /** Instinct-internal route to the meeting detail page (when we have
   *  a transcript / feed linked). */
  instinctDetailHref?: string;
}

export interface CalendarWidgetSpec {
  kind: "calendar";
  /** ISO date for the 1st of the displayed month (e.g. "2026-05-01"). */
  month: string;
  /** ISO datetime range the events cover. The renderer uses these to
   *  decide which days fall inside the visible grid. */
  rangeStart: string;
  rangeEnd: string;
  events: CalendarWidgetEvent[];
  /** Heading rendered above the grid. Defaults to "Your calendar" when
   *  the widget is the user's own; can be set to "Hoxsie's calendar"
   *  for someone-else-lookup variants in the future. */
  title?: string;
}

/** Discriminated union of every widget kind. Add new entries as the
 *  framework expands. */
export type WidgetSpec = CalendarWidgetSpec;
