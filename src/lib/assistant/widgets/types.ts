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
  /** Optional ISO meeting start. When present, the widget substitutes
   *  the `{time}` token in `context` with the locally-formatted time.
   *  Server emits the raw ISO because Vercel functions run in UTC. */
  meetingStartTime?: string;
}

/** A meeting surfaced in the Pre-Brief section. The widget bakes the
 *  full list of upcoming meetings (next 48h) + a default selection so
 *  the renderer can switch between them client-side without refetching. */
export interface GoodMorningPreBriefMeeting {
  id: string;
  subject: string;
  /** ISO start. */
  start: string;
  /** ISO end. */
  end: string;
  location: string;
  attendees: string[];
  isOnlineMeeting: boolean;
  /** Computed server-side; renderer re-derives live so the countdown
   *  ticks forward without refetching. */
  minutesUntil: number | null;
  inProgress: boolean;
}

export interface GoodMorningPreBrief {
  /** When null, the section renders a "no meetings in the next 48h"
   *  hint matching the dashboard panel's empty state. */
  defaultMeetingId: string | null;
  /** Up to ~20 upcoming + just-ended meetings. */
  meetings: GoodMorningPreBriefMeeting[];
  /** Window the server used (so the empty-state message stays in sync). */
  lookaheadHours: number;
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
  /** Meeting Pre-Brief section — same source as the dashboard panel.
   *  Optional so older persisted widgets don't crash; the renderer
   *  treats missing as "no pre-brief available". */
  preBrief?: GoodMorningPreBrief;
  /** When false, the widget shows a "connect Microsoft 365" hint
   *  instead of the populated panels. */
  connected: boolean;
}

/** A single row in a DMS inventory widget. Vendor-neutral shape; each
 *  DMS driver maps its native fields into this canonical form so the
 *  widget renders the same regardless of which dealer system was
 *  driven under the hood. */
export interface DmsInventoryItem {
  title: string;
  year: number | null;
  make: string | null;
  model: string | null;
  price: number | null;
  vin: string | null;
  imageUrl: string | null;
  detailUrl: string | null;
}

export interface DmsInventoryWidgetSpec {
  kind: "dms_inventory";
  /** Which DMS the driver targeted (wolfpack-auto, cdk, tekion, ...). */
  vendor: string;
  title: string;
  subtitle?: string;
  items: DmsInventoryItem[];
}

/** Universal-search results rendered inline in the chat surface.
 *  Mirrors the /search page's source-filter UX (one checkbox per
 *  source that has non-zero results; toggling hides rows of that
 *  type client-side). The shape is intentionally identical to
 *  `SearchResponse` from `src/lib/search/runSearch.ts` — the tool
 *  hands its data through unchanged.
 *
 *  Why duplicate the SearchResult shape here instead of importing
 *  it: keeps `src/lib/assistant/widgets/types.ts` import-graph small
 *  (no transitive `runSearch` provider load) and matches the
 *  "widget specs are pure JSON shapes" convention every other widget
 *  follows. The fields are kept structurally identical and the
 *  guardrail test asserts that. */
export interface SearchResultsWidgetResult {
  type: "chat" | "channel" | "email" | "calendar" | "knowledge" | "crm" | "dms";
  id: string;
  title: string;
  snippet: string;
  /** ISO timestamp; may be empty when the source has no timestamp. */
  timestamp: string;
  url?: string;
}

export interface SearchResultsWidgetCounts {
  chats: number;
  channels: number;
  emails: number;
  calendar: number;
  knowledge: number;
  crm: number;
  [key: string]: number;
}

export interface SearchResultsWidgetSpec {
  kind: "search_results";
  /** The query the user typed; surfaced in the "Search again" prompt
   *  and the no-results empty state. */
  query: string;
  /** The full result list — the renderer filters client-side based on
   *  the active source checkboxes, so no refetch is needed when the
   *  user toggles a source off and back on. */
  results: SearchResultsWidgetResult[];
  /** Per-source totals. Keys with `> 0` get a checkbox; sources with
   *  zero hits are hidden from the filter row (mirrors /search). */
  counts: SearchResultsWidgetCounts;
  /** Wall-clock latency the engine reported. Surfaced in the meta
   *  line under the filter row ("12 results in 87ms"). */
  took_ms: number;
}

/** Empty-state demo widgets — weather, headlines, fx. Backed by free
 *  public APIs (no key required) so a brand-new user with zero
 *  integrations connected still sees value within the first 30 seconds.
 *  Pure data shapes; the renderers live in `src/components/widgets/`. */
export interface WeatherWidgetSpec {
  kind: "weather";
  /** Resolved place name, e.g. "Boston, Massachusetts, US". */
  location: string;
  temperatureC: number;
  temperatureF: number;
  /** Human-friendly condition string ("Partly cloudy", "Rainy", …) */
  condition: string;
  highC: number;
  lowC: number;
  /** Relative humidity (0..100). */
  humidity: number;
  windMph: number;
}

export interface HeadlineWidgetItem {
  title: string;
  link: string;
  /** Original feed pubDate string (kept as-is so the renderer can
   *  format it relative to "now" in the browser TZ). */
  published: string;
  source: string;
}

export interface HeadlinesWidgetSpec {
  kind: "headlines";
  title: string;
  subtitle?: string;
  items: HeadlineWidgetItem[];
}

export interface FxWidgetRate {
  code: string;
  value: number;
}

export interface FxWidgetSpec {
  kind: "fx";
  base: string;
  /** YYYY-MM-DD of the rate snapshot. */
  asOf: string;
  rates: FxWidgetRate[];
}

/** Upload-to-Brain widget. The canonical "user-driven Brain ingest"
 *  surface — a dedicated drag/drop panel rendered inline in the chat
 *  with a per-file accepted/rejected status board. Backed by the
 *  data-quality filter at /api/brain/upload (see
 *  `src/lib/brain/upload-filter.ts`). The chat-input drag/drop in
 *  `InstinctChat.tsx` is the secondary path into the same pipeline. */
export interface UploadToBrainWidgetSpec {
  kind: "upload_to_brain";
  /** Route the widget POSTs each file to (multipart). Plumbed so the
   *  spec is self-contained — the widget never hard-codes endpoints. */
  uploadUrl: string;
  /** Hard size cap surfaced in the help text + used for client-side
   *  validation before the POST. Should match the server filter's
   *  UPLOAD_FILTER_MAX_FILE_SIZE_BYTES. */
  maxFileSize: number;
  /** MIME allowlist surfaced as the drag/drop hint + used by the
   *  client to short-circuit obviously-disallowed drops. Server still
   *  enforces independently. */
  allowedMimeTypes: readonly string[];
}

/** Meeting Pre-Brief widget — the first cross-source synthesis surface.
 *  Shape mirrors the MeetingPrep type from src/lib/insights/meeting-prep-synthesize
 *  so the widget can render the LLM-synthesized fields plus the cache
 *  metadata the route returns. The full prep object lives at `data`;
 *  the renderer reads it straight without re-fetching. */
export interface MeetingPrepWidgetSourceRef {
  type: string;
  id: string;
  label: string;
  url?: string;
}

export interface MeetingPrepWidgetTalkingPoint {
  point: string;
  source_refs: MeetingPrepWidgetSourceRef[];
}

export interface MeetingPrepWidgetRiskFlag {
  flag: string;
  severity: "low" | "med" | "high";
  source_refs: MeetingPrepWidgetSourceRef[];
}

export interface MeetingPrepWidgetAttendeeBrief {
  email: string;
  name?: string;
  one_liner: string;
  key_facts: string[];
  links: MeetingPrepWidgetSourceRef[];
}

export interface MeetingPrepWidgetSpec {
  kind: "meeting_prep";
  /** Meeting Graph id — used by the regenerate handler to call the API
   *  route with the same event. */
  meetingId: string;
  /** Header text: meeting subject. */
  subject: string;
  /** ISO start timestamp. */
  start: string;
  /** "hit" → shared-with-team pill; "miss" / "regenerated" → fresh pill. */
  cacheStatus: "hit" | "miss" | "regenerated";
  /** ISO timestamp of the underlying synthesis (or the cached row). */
  generatedAt: string;
  /** When true, the route returned `synthesis_unavailable` and the
   *  widget renders the raw sources instead of the synthesized prep. */
  synthesisUnavailable: boolean;
  summary: string;
  goal: string;
  talking_points: MeetingPrepWidgetTalkingPoint[];
  risk_flags: MeetingPrepWidgetRiskFlag[];
  attendee_briefs: MeetingPrepWidgetAttendeeBrief[];
  open_questions: string[];
  /** Role on the viewer's account — gates the "Regenerate" button to
   *  manager+. Computed server-side so the widget doesn't trust the
   *  client to enforce. */
  viewerCanRegenerate: boolean;
}

/** Feedback widget — surfaced by the `feedback` assistant tool. Two
 *  shapes share one component so a single widget kind covers both paths
 *  the team-onboarding flow needs:
 *    1. Slash command with body (`/feedback the calendar widget is
 *       broken`) → the tool already wrote the row; widget renders the
 *       "thanks, recorded as #<short>" confirmation echoing the
 *       captured text.
 *    2. Bare slash command (`/feedback`) → the tool returns the widget
 *       with `mode: "compose"` so the user fills in a textarea and the
 *       widget POSTs to /api/feedback. On 200 it swaps to the recorded
 *       state in place. */
export interface FeedbackWidgetSpec {
  kind: "feedback";
  /** "recorded" → the slash command carried a body that's already
   *  written; widget renders confirmation only. "compose" → the user
   *  typed a bare `/feedback`, so the widget renders a textarea +
   *  submit and POSTs to /api/feedback on click. */
  mode: "recorded" | "compose";
  /** UUID of the inserted row (mode=recorded only). The widget shows
   *  the first 8 characters as a human-readable confirmation token. */
  feedbackId?: string;
  /** Echo of what the user said (mode=recorded only). Keeps the
   *  thank-you self-evident so the user can verify capture without
   *  scrolling back up. */
  message?: string;
  /** Optional surface label included in the recorded row + analytics
   *  ("/assistant", "/sites", "/brain"). Best-effort; absent in tests
   *  and server-to-server callers. */
  surface?: string;
  /** Endpoint the compose-mode widget POSTs to. Self-contained so the
   *  widget never hard-codes routes — keeps the spec testable in
   *  isolation. */
  submitUrl: string;
}

/** Discriminated union of every widget kind. Add new entries as the
 *  framework expands. */
export type WidgetSpec =
  | CalendarWidgetSpec
  | EmailThreadWidgetSpec
  | TaskListWidgetSpec
  | GoodMorningWidgetSpec
  | DmsInventoryWidgetSpec
  | SearchResultsWidgetSpec
  | WeatherWidgetSpec
  | HeadlinesWidgetSpec
  | FxWidgetSpec
  | UploadToBrainWidgetSpec
  | MeetingPrepWidgetSpec
  | FeedbackWidgetSpec;
