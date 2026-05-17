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

/** A single message in an email-thread widget. */
export interface EmailThreadMessage {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  /** ISO timestamp Graph returned (receivedDateTime). */
  receivedAt: string;
  /** Short snippet (Graph's bodyPreview) — capped server-side. */
  preview: string;
  isRead: boolean;
  importance: "low" | "normal" | "high";
  /** Outlook web link (open in Outlook). */
  webLink?: string;
  /** In-app deep link (when we have a reader for the id). */
  instinctDetailHref?: string;
}

export interface EmailThreadWidgetSpec {
  kind: "email_thread";
  /** Heading rendered above the list (e.g. "Recent inbox",
   *  "Emails from Hoxsie"). */
  title: string;
  /** Optional filter description shown under the title in muted text
   *  ("from hoxsie@…", "last 24h"). */
  subtitle?: string;
  messages: EmailThreadMessage[];
}

/** A single row in a task-list widget. */
export interface TaskListItem {
  id: string;
  title: string;
  status: "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";
  importance: "low" | "normal" | "high";
  /** ISO timestamp; null when the task has no due date. */
  dueAt: string | null;
  /** Local list UUID (used by the optimistic-complete handler to scope
   *  the PATCH call). */
  listId: string;
  /** Friendly list name shown next to the title ("Inbox", "Work"). */
  listName?: string;
}

export interface TaskListWidgetSpec {
  kind: "task_list";
  title: string;
  /** Optional filter description (e.g. "due today", "all open"). */
  subtitle?: string;
  tasks: TaskListItem[];
}

/** A single attendee in a meeting pre-brief. */
export interface GoodMorningAttendee {
  name: string;
}

/** Today's calendar events surfaced in the good-morning widget. */
export interface GoodMorningEvent {
  subject: string;
  startTime: string;
  endTime: string;
  attendees: string[];
  location?: string;
}

/** A queued action item (high-signal email, overdue invoice, etc.). */
export interface GoodMorningActionItem {
  priority: "high" | "medium" | "low";
  text: string;
  context: string;
  link?: string;
  source?: "email" | "meeting" | "invoice" | "client" | "receivable";
}

export interface GoodMorningWidgetSpec {
  kind: "good_morning";
  /** Localized greeting line, e.g. "Good morning, Nick". */
  greeting: string;
  /** One-line summary under the greeting. */
  summary: string;
  schedule: {
    eventCount: number;
    events: GoodMorningEvent[];
  };
  actionItems: GoodMorningActionItem[];
  /** When false, the widget shows a "connect Microsoft 365" hint
   *  instead of the populated panels. */
  connected: boolean;
}

/** Discriminated union of every widget kind. Add new entries as the
 *  framework expands. */
export type WidgetSpec =
  | CalendarWidgetSpec
  | EmailThreadWidgetSpec
  | TaskListWidgetSpec
  | GoodMorningWidgetSpec;
