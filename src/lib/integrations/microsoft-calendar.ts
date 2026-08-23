/**
 * Microsoft 365 Calendar integration (Calendars.ReadWrite scope).
 *
 * Wraps Graph /me/events for create/update/delete/list. Every mutation:
 *   1. Calls Graph with write-through semantics
 *   2. Logs an instinct_calendar_events_written row
 *   3. Records an audit entry (calendar.event.*)
 *   4. Emits a system.ms_calendar_event_{action} analytics event
 *
 * Never throws on expected Graph errors — always returns Result<T>.
 * Callers (routes, UI) discriminate via `code`.
 *
 * Online meeting support: if onlineMeetingProvider is supplied the field
 * is passed to Graph. Instinct UI today keeps Teams disabled (Tier 2),
 * but the plumbing lives here so Stream C can enable it without touching
 * this file again.
 */
 

import { getValidToken, type CalendarEvent } from "@/lib/microsoft-graph";
import { normalizeGraphDateTime } from "@/lib/calendar/timezone";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";

// ---------------------------------------------------------------------------
// Result type (mirrors microsoft-mail.ts — kept local so the two libs can
// evolve independently).
// ---------------------------------------------------------------------------

export type CalendarErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "graph_error"
  | "internal";

export interface CalendarErrorResult {
  ok: false;
  code: CalendarErrorCode;
  scope?: string;
  retryAfter?: number;
  status?: number;
  message?: string;
}

export interface CalendarOkResult<T> {
  ok: true;
  value: T;
}

export type Result<T> = CalendarOkResult<T> | CalendarErrorResult;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  subject: string;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
  timeZone?: string; // default "UTC"
  attendees?: string[]; // email addresses
  location?: string;
  bodyHtml?: string;
  bodyText?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: "teamsForBusiness" | "skypeForBusiness" | "skypeForConsumer" | null;
}

export interface UpdateEventInput {
  subject?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
  location?: string;
  bodyHtml?: string;
  bodyText?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: "teamsForBusiness" | "skypeForBusiness" | "skypeForConsumer" | null;
}

export interface ListEventsOpts {
  from?: string; // ISO 8601
  to?: string;   // ISO 8601
  limit?: number;
}

export interface CreatedEventSummary {
  id: string;
  webLink: string | null;
}

export interface UpdatedEventSummary {
  id: string;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

interface GraphCallSuccess<T> {
  ok: true;
  status: number;
  data: T | null;
}

interface GraphCallError {
  ok: false;
  status: number;
  code: CalendarErrorCode;
  scope?: string;
  retryAfter?: number;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res: Response): Promise<any | null> {
  try { return await res.json(); } catch { return null; }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function classify403(body: any): { code: CalendarErrorCode; scope?: string; message: string } {
  const errCode = body?.error?.code || body?.error?.innerError?.code || "";
  const errMsg = body?.error?.message || "forbidden";
  const isScope =
    /AccessDenied/i.test(String(errCode)) ||
    /Authorization_RequestDenied/i.test(String(errCode)) ||
    /scope/i.test(errMsg) ||
    /permission/i.test(errMsg);
  if (isScope) {
    return { code: "scope_missing", scope: "Calendars.ReadWrite", message: errMsg };
  }
  return { code: "graph_error", message: errMsg };
}

async function graphCall<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  accessToken: string,
  body?: unknown,
): Promise<GraphCallSuccess<T> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;

  const doCall = () =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res: Response;
  try {
    res = await doCall();
  } catch (err) {
    return { ok: false, status: 0, code: "internal", message: `network_error: ${(err as Error).message}` };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await sleep(retryAfter * 1000);
    let retry: Response;
    try {
      retry = await doCall();
    } catch (err) {
      return { ok: false, status: 0, code: "internal", retryAfter, message: `network_error_after_retry: ${(err as Error).message}` };
    }
    if (retry.status === 429) {
      return { ok: false, status: 429, code: "rate_limited", retryAfter, message: "rate_limited_after_retry" };
    }
    res = retry;
  }

  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 403) {
    const b = await safeJson(res);
    const c = classify403(b);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: "not_found", message: "event_not_found" };
  }
  if (!res.ok) {
    const text = await safeText(res);
    return { ok: false, status: res.status, code: "graph_error", message: `graph_${res.status}: ${text.slice(0, 200)}` };
  }

  if (res.status === 204) return { ok: true, status: 204, data: null };
  const data = (await safeJson(res)) as T | null;
  return { ok: true, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function isoOrNull(value: string | undefined | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function buildGraphBody(input: CreateEventInput | UpdateEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("subject" in input && input.subject !== undefined) body.subject = input.subject;

  const tz = input.timeZone ?? "UTC";
  if ("start" in input && input.start) {
    body.start = { dateTime: input.start, timeZone: tz };
  }
  if ("end" in input && input.end) {
    body.end = { dateTime: input.end, timeZone: tz };
  }
  if ("location" in input && input.location !== undefined) {
    body.location = { displayName: input.location ?? "" };
  }
  if ("attendees" in input && Array.isArray(input.attendees)) {
    body.attendees = input.attendees
      .map((a) => (typeof a === "string" ? a.trim() : ""))
      .filter((a) => a.length > 0)
      .map((address) => ({ emailAddress: { address }, type: "required" }));
  }
  const html = input.bodyHtml;
  const text = input.bodyText;
  if (html !== undefined || text !== undefined) {
    body.body = html
      ? { contentType: "HTML", content: html }
      : { contentType: "Text", content: text ?? "" };
  }
  if (input.isOnlineMeeting !== undefined) body.isOnlineMeeting = input.isOnlineMeeting;
  if (input.onlineMeetingProvider !== undefined && input.onlineMeetingProvider !== null) {
    body.onlineMeetingProvider = input.onlineMeetingProvider;
  }
  return body;
}

function validateCreate(input: CreateEventInput): CalendarErrorResult | null {
  if (!input || typeof input !== "object") return { ok: false, code: "invalid_input", message: "missing_body" };
  if (!input.subject || input.subject.trim().length === 0) return { ok: false, code: "invalid_input", message: "subject_required" };
  if (!input.start || !input.end) return { ok: false, code: "invalid_input", message: "start_end_required" };
  const s = isoOrNull(input.start);
  const e = isoOrNull(input.end);
  if (!s || !e) return { ok: false, code: "invalid_input", message: "invalid_date" };
  if (new Date(e).getTime() <= new Date(s).getTime()) {
    return { ok: false, code: "invalid_input", message: "end_must_be_after_start" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache + audit
// ---------------------------------------------------------------------------

async function recordCalendarWrite(params: {
  userId: string;
  msEventId: string;
  action: "created" | "updated" | "deleted";
  subject: string | null;
  startAt: string | null;
  endAt: string | null;
  attendees: string[];
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO instinct_calendar_events_written
         (user_id, ms_event_id, action, subject, start_at, end_at, attendees, payload, performed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        params.userId,
        params.msEventId,
        params.action,
        params.subject,
        params.startAt,
        params.endAt,
        JSON.stringify(params.attendees),
        JSON.stringify(params.payload),
      ],
    );
  } catch (err) {
    console.warn("[microsoft-calendar] Failed to write cache row:", (err as Error).message);
  }
}

async function auditCalendar(params: {
  userId: string;
  role: string;
  action: string; // calendar.event.created|updated|deleted
  msEventId: string;
  subject: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}): Promise<void> {
  try {
    await recordAudit({
      actor: { user_id: params.userId, role: params.role },
      action: params.action,
      resourceType: "calendar_event",
      resourceId: params.msEventId,
      beforeState: params.beforeState,
      afterState: params.afterState,
    });
  } catch (err) {
    console.warn("[microsoft-calendar] audit record failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createEvent(
  userId: string,
  input: CreateEventInput,
  role = "system",
): Promise<Result<CreatedEventSummary>> {
  const invalid = validateCreate(input);
  if (invalid) return invalid;

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_calendar_operation_failed", userId, role, {
      op: "create",
      reason: "not_connected",
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const body = buildGraphBody(input);
  const res = await graphCall<any>("POST", "me/events", token.accessToken, body);

  if (!res.ok) {
    trackEvent("system.ms_calendar_operation_failed", userId, role, {
      op: "create",
      reason: res.code,
      status: res.status ?? 0,
      scope: res.scope ?? "",
    });
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const id: string = res.data?.id ?? `event:${Date.now()}`;
  const webLink: string | null = res.data?.webLink ?? null;

  await recordCalendarWrite({
    userId,
    msEventId: id,
    action: "created",
    subject: input.subject,
    startAt: isoOrNull(input.start),
    endAt: isoOrNull(input.end),
    attendees: input.attendees ?? [],
    payload: { input, webLink },
  });

  await auditCalendar({
    userId,
    role,
    action: "calendar.event.created",
    msEventId: id,
    subject: input.subject,
    afterState: {
      subject: input.subject,
      start: input.start,
      end: input.end,
      attendees: input.attendees ?? [],
      location: input.location ?? "",
    },
  });

  trackEvent("system.ms_calendar_event_created", userId, role, {
    event_id: id,
    attendee_count: (input.attendees ?? []).length,
    is_online: Boolean(input.isOnlineMeeting),
    subject_len: input.subject.length,
  });

  return { ok: true, value: { id, webLink } };
}

export async function updateEvent(
  userId: string,
  eventId: string,
  patch: UpdateEventInput,
  role = "system",
): Promise<Result<UpdatedEventSummary>> {
  if (!eventId) return { ok: false, code: "invalid_input", message: "event_id_required" };
  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
    return { ok: false, code: "invalid_input", message: "empty_patch" };
  }
  if (patch.start && !isoOrNull(patch.start)) return { ok: false, code: "invalid_input", message: "invalid_start" };
  if (patch.end && !isoOrNull(patch.end)) return { ok: false, code: "invalid_input", message: "invalid_end" };

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_calendar_operation_failed", userId, role, {
      op: "update",
      reason: "not_connected",
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const body = buildGraphBody(patch);
  const res = await graphCall<any>(
    "PATCH",
    `me/events/${encodeURIComponent(eventId)}`,
    token.accessToken,
    body,
  );

  if (!res.ok) {
    trackEvent("system.ms_calendar_operation_failed", userId, role, {
      op: "update",
      reason: res.code,
      status: res.status ?? 0,
      event_id: eventId,
      scope: res.scope ?? "",
    });
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const id: string = res.data?.id ?? eventId;

  await recordCalendarWrite({
    userId,
    msEventId: id,
    action: "updated",
    subject: patch.subject ?? res.data?.subject ?? null,
    startAt: isoOrNull(patch.start ?? res.data?.start?.dateTime ?? null),
    endAt: isoOrNull(patch.end ?? res.data?.end?.dateTime ?? null),
    attendees: patch.attendees ?? [],
    payload: { patch },
  });

  await auditCalendar({
    userId,
    role,
    action: "calendar.event.updated",
    msEventId: id,
    subject: patch.subject ?? null,
    afterState: patch,
  });

  trackEvent("system.ms_calendar_event_updated", userId, role, {
    event_id: id,
    fields_changed: Object.keys(patch).join(","),
  });

  return { ok: true, value: { id } };
}

export async function deleteEvent(
  userId: string,
  eventId: string,
  role = "system",
): Promise<Result<void>> {
  if (!eventId) return { ok: false, code: "invalid_input", message: "event_id_required" };

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_calendar_operation_failed", userId, role, {
      op: "delete",
      reason: "not_connected",
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const res = await graphCall<unknown>(
    "DELETE",
    `me/events/${encodeURIComponent(eventId)}`,
    token.accessToken,
  );

  if (!res.ok) {
    trackEvent("system.ms_calendar_operation_failed", userId, role, {
      op: "delete",
      reason: res.code,
      status: res.status ?? 0,
      event_id: eventId,
      scope: res.scope ?? "",
    });
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  await recordCalendarWrite({
    userId,
    msEventId: eventId,
    action: "deleted",
    subject: null,
    startAt: null,
    endAt: null,
    attendees: [],
    payload: {},
  });

  await auditCalendar({
    userId,
    role,
    action: "calendar.event.deleted",
    msEventId: eventId,
    subject: null,
    beforeState: { event_id: eventId },
  });

  trackEvent("system.ms_calendar_event_deleted", userId, role, {
    event_id: eventId,
  });

  return { ok: true, value: undefined };
}

/**
 * List events in a time window. Read-only — no cache write, no audit.
 * Analytics events fire only on mutations.
 */
/** Graph's maximum page for calendarview. */
const GRAPH_PAGE_SIZE = 200;
/**
 * A ceiling on paging, so a server that always claims there is more cannot
 * hold a request open forever. Twenty-five pages is five thousand events,
 * well past any real quarter.
 */
const MAX_GRAPH_PAGES = 25;

export async function listEvents(
  userId: string,
  opts: ListEventsOpts = {},
): Promise<CalendarEvent[]> {
  const token = await getValidToken(userId);
  if (!token) return [];

  const from = opts.from ? new Date(opts.from) : new Date();
  const to = opts.to ? new Date(opts.to) : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  const wanted = Math.max(opts.limit ?? 50, 1);
  /* Graph's own page size. The caller's limit is what they want in total,
     which is a different number and used to be conflated with this one. */
  const top = Math.min(wanted, GRAPH_PAGE_SIZE);

  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  const endpoint =
    `me/calendarview?startDateTime=${encodeURIComponent(fromISO)}` +
    `&endDateTime=${encodeURIComponent(toISO)}` +
    `&$orderby=start/dateTime&$top=${top}` +
    /* WHAT MAKES SOMETHING A MEETING.
       This asked for subject, start, end, location, attendees and
       isOnlineMeeting, and nothing about whether the event was cancelled,
       whether this person declined it, or whether it is a Focus Time block
       Outlook created that nobody attends. All three counted as meetings,
       which inflates the meeting total and destroys the usable-block
       measure the analysis exists to produce. */
    `&$select=id,subject,start,end,location,attendees,isOnlineMeeting,showAs,isCancelled,isAllDay,responseStatus`;

  type RawEvent = {
    id: string;
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    location?: { displayName?: string };
    attendees?: { emailAddress: { name?: string; address: string } }[];
    isOnlineMeeting?: boolean;
    showAs?: string;
    isCancelled?: boolean;
    isAllDay?: boolean;
    responseStatus?: { response?: string };
  };

  /* PAGE UNTIL WE HAVE WHAT WAS ASKED FOR.
     $top was clamped to 200 and nothing followed @odata.nextLink, so any
     window holding more than 200 events was silently truncated and its
     totals reported as though they were the whole window. On a 90-day
     analysis that under-counts meetings and over-counts free time, which is
     backwards for the one claim this makes, and it fails as a plausible
     number rather than as an error. */
  const raw: RawEvent[] = [];
  let next: string | null = endpoint;
  let pages = 0;
  while (next && raw.length < wanted && pages < MAX_GRAPH_PAGES) {
    const res: GraphCallSuccess<{ value?: RawEvent[]; "@odata.nextLink"?: string }> | GraphCallError =
      await graphCall<{ value?: RawEvent[]; "@odata.nextLink"?: string }>(
        "GET",
        next,
        token.accessToken,
      );
    if (!res.ok || !res.data?.value) break;
    raw.push(...res.data.value);
    next = res.data["@odata.nextLink"] ?? null;
    pages++;
  }

  return raw.slice(0, wanted).map((ev) => {
    const rawAttendees = ev.attendees || [];
    return {
      id: ev.id,
      subject: ev.subject,
      // Graph returns a naive wall-clock string plus a separate timeZone.
      // Normalize to a real UTC instant so callers (and new Date()) do not
      // read a UTC value as local time, which shifted events across days.
      start: normalizeGraphDateTime(ev.start.dateTime, ev.start.timeZone),
      end: normalizeGraphDateTime(ev.end.dateTime, ev.end.timeZone),
      location: ev.location?.displayName || "",
      attendees: rawAttendees.map((a) => a.emailAddress.name || a.emailAddress.address),
      attendeeEmails: rawAttendees
        .map((a) => (a.emailAddress.address || "").trim().toLowerCase())
        .filter((addr) => addr.includes("@")),
      isOnlineMeeting: ev.isOnlineMeeting || false,
      /* Passed through rather than acted on here. Whether a declined
         meeting counts is the caller's question: a schedule analysis says
         no, and a "what did I miss" view would say yes. */
      showAs: (ev.showAs as CalendarEvent["showAs"]) ?? "unknown",
      isCancelled: ev.isCancelled ?? false,
      isAllDay: ev.isAllDay ?? false,
      responseStatus: ev.responseStatus?.response ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Search (read-only) — used by the assistant context resolver.
//
// We expose a thin keyword-aware search wrapper over `/me/calendarView` so the
// assistant can ground meeting questions ("what did we discuss in the porsche
// meetings?") in the user's own calendar. Same scope as the read path
// (`Calendars.Read`) — no separate consent needed.
//
// Strategy:
//   1. Take a date range (extracted from the question by the resolver, or a
//      sensible default of [now-180d, now+30d]).
//   2. Pull up to ~50 events in that window via Graph $top.
//   3. Score each event in JS by simple substring match against subject,
//      bodyPreview/body, and attendee display names. No tokenizer — we keep
//      this zero-cost; the resolver passes the raw question.
//   4. Return the top N (default 5) hits in CalendarEventHit shape.
// ---------------------------------------------------------------------------

import { trackEvent as trackEventForSearch } from "@/lib/analytics";

/**
 * Hit shape the context resolver consumes. Stable + minimal — Outlook deep
 * link + ISO datetimes so the LLM can ground date claims rather than
 * paraphrase.
 */
export interface CalendarEventHit {
  id: string;
  subject: string;
  start: string;        // ISO datetime
  end: string;          // ISO datetime
  organizer?: string;
  attendees?: string[]; // display names, deduped
  snippet: string;      // <= 300 char body excerpt
  url?: string;         // Outlook web deep link (webLink)
  source_kind: "calendar";
}

export interface SearchCalendarEventsOptions {
  /** Free-text query — typically the raw question. */
  query: string;
  /** ISO start of the window. Defaults to 180 days ago. */
  startDateTime?: string;
  /** ISO end of the window. Defaults to 30 days ahead. */
  endDateTime?: string;
  /** How many hits to return. Default 5, capped at 25. */
  topN?: number;
}

export interface SearchCalendarEventsValue {
  hits: CalendarEventHit[];
  total: number;
  took_ms: number;
}

/** Hard cap on snippet length surfaced into the prompt — matches resolver. */
const CALENDAR_SNIPPET_MAX = 300;
const CALENDAR_DEFAULT_TOP_N = 5;
const CALENDAR_TOP_N_CAP = 25;
/** How many candidates to pull from Graph before keyword-ranking. */
const CALENDAR_FETCH_TOP = 50;

interface RawCalendarEvent {
  id: string;
  subject?: string | null;
  start?: { dateTime?: string; timeZone?: string } | null;
  end?: { dateTime?: string; timeZone?: string } | null;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string } | null;
  organizer?: { emailAddress?: { name?: string; address?: string } } | null;
  attendees?: Array<{ emailAddress?: { name?: string; address?: string } }> | null;
  webLink?: string | null;
}

function clipCalendarSnippet(s: string): string {
  if (!s) return "";
  const stripped = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length <= CALENDAR_SNIPPET_MAX
    ? stripped
    : stripped.slice(0, CALENDAR_SNIPPET_MAX - 1).trim() + "…";
}

/**
 * Tokenize a raw question into lowercase tokens of length >= 3, dropping the
 * most generic English stop words. We don't need a real stemmer — for
 * "porsche meetings march" we just want "porsche", "meetings", "march" so
 * subject substring matches them.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "what", "did", "was", "were", "been", "have", "has",
  "with", "about", "from", "this", "that", "they", "them", "their", "there",
  "when", "which", "who", "whose", "why", "how", "are", "you", "your", "our",
  "all", "any", "into", "out", "of", "in", "on", "at", "to", "by", "or", "as",
  "be", "is", "we", "i", "a", "an", "do", "does", "did", "had", "but", "not",
  "discuss", "discussed", "meeting", "meetings", "talk", "talked", "talks",
]);

function tokenize(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const lower = String(question || "").toLowerCase();
  const matches = lower.match(/[a-z0-9]+/g) || [];
  for (const tok of matches) {
    if (tok.length < 3) continue;
    if (STOP_WORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function scoreEvent(ev: RawCalendarEvent, tokens: string[]): number {
  if (tokens.length === 0) return 1; // no filter — keep ordering
  const subject = String(ev.subject || "").toLowerCase();
  const preview = String(ev.bodyPreview || "").toLowerCase();
  const body = String(ev.body?.content || "").toLowerCase();
  const attNames = (ev.attendees || [])
    .map((a) => String(a.emailAddress?.name || a.emailAddress?.address || "").toLowerCase())
    .join(" ");
  let score = 0;
  for (const t of tokens) {
    // Subject hits weigh most — they are short + intentional.
    if (subject.includes(t)) score += 5;
    if (preview.includes(t)) score += 2;
    if (body.includes(t)) score += 2;
    if (attNames.includes(t)) score += 3;
  }
  return score;
}

function dedupeAttendeeNames(raw: RawCalendarEvent): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw.attendees || []) {
    const name = a.emailAddress?.name || a.emailAddress?.address || "";
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeCalendarHit(raw: RawCalendarEvent): CalendarEventHit | null {
  if (!raw || !raw.id) return null;
  const start = raw.start?.dateTime || "";
  const end = raw.end?.dateTime || "";
  if (!start || !end) return null;
  const snippetSource = raw.bodyPreview || raw.body?.content || "";
  const organizerName =
    raw.organizer?.emailAddress?.name || raw.organizer?.emailAddress?.address || "";
  const hit: CalendarEventHit = {
    id: raw.id,
    subject: raw.subject || "(no subject)",
    start,
    end,
    snippet: clipCalendarSnippet(snippetSource),
    source_kind: "calendar",
  };
  if (organizerName) hit.organizer = organizerName;
  const attendees = dedupeAttendeeNames(raw);
  if (attendees.length > 0) hit.attendees = attendees;
  if (raw.webLink) hit.url = raw.webLink;
  return hit;
}

/**
 * Search the user's calendar for events matching `query` within an ISO date
 * window. Pulls /me/calendarView, then keyword-ranks in JS so we never hit
 * Graph beyond a single read call.
 *
 * Returns a typed Result. On 403 returns `scope_missing` with `Calendars.Read`
 * so the assistant UI can prompt the user to reconnect their Microsoft
 * account if the consent has been revoked.
 *
 * Privacy: token MUST be the calling user's delegated token. Graph already
 * scopes /me/calendarView to that user.
 */
export async function searchCalendarEvents(
  token: string,
  opts: SearchCalendarEventsOptions,
): Promise<Result<SearchCalendarEventsValue>> {
  const t0 = Date.now();
  const q = String(opts?.query ?? "").trim();
  if (!q) return { ok: false, code: "invalid_input", message: "query_required" };
  if (!token || typeof token !== "string") {
    return { ok: false, code: "not_connected", message: "missing_token" };
  }

  const requested = Number.isFinite(opts.topN) ? Number(opts.topN) : CALENDAR_DEFAULT_TOP_N;
  const topN = Math.min(Math.max(requested, 1), CALENDAR_TOP_N_CAP);

  // Default window: 180 days back, 30 days forward — covers "porsche
  // meetings in March" today, plus the upcoming agenda.
  const now = Date.now();
  const fromISO =
    opts.startDateTime && !isNaN(new Date(opts.startDateTime).getTime())
      ? new Date(opts.startDateTime).toISOString()
      : new Date(now - 180 * 24 * 3600 * 1000).toISOString();
  const toISO =
    opts.endDateTime && !isNaN(new Date(opts.endDateTime).getTime())
      ? new Date(opts.endDateTime).toISOString()
      : new Date(now + 30 * 24 * 3600 * 1000).toISOString();

  const select =
    "id,subject,start,end,bodyPreview,body,organizer,attendees,webLink";
  const endpoint =
    `me/calendarView?startDateTime=${encodeURIComponent(fromISO)}` +
    `&endDateTime=${encodeURIComponent(toISO)}` +
    `&$orderby=${encodeURIComponent("start/dateTime desc")}` +
    `&$top=${CALENDAR_FETCH_TOP}` +
    `&$select=${encodeURIComponent(select)}`;

  const res = await graphCall<{ value?: RawCalendarEvent[] }>(
    "GET",
    endpoint,
    token,
  );

  if (!res.ok) {
    /* The shared graphCall helper classifies 403s with the write scope
       label since that's the broader requirement; for the read-only search
       path we surface Calendars.Read so the UI prompt is accurate. */
    const scope =
      res.code === "scope_missing"
        ? "Calendars.Read"
        : res.scope;
    return {
      ok: false,
      code: res.code,
      scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const raw = Array.isArray(res.data?.value) ? res.data!.value! : [];
  const tokens = tokenize(q);
  const scored = raw
    .map((ev) => ({ ev, score: scoreEvent(ev, tokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const hits = scored
    .slice(0, topN)
    .map((s) => normalizeCalendarHit(s.ev))
    .filter((h): h is CalendarEventHit => h !== null);

  return {
    ok: true,
    value: { hits, total: scored.length, took_ms: Date.now() - t0 },
  };
}

/**
 * Track a calendar-lookup failure as a typed analytics event so the
 * assistant dashboard can show "calendar context surface failed" alongside
 * the SharePoint / Project surfaces.
 */
export function trackCalendarLookupFailure(
  userId: string,
  role: string,
  error: CalendarErrorResult,
): void {
  trackEventForSearch("assistant.calendar_lookup_failed", userId, role, {
    status: error.status ?? 0,
    scope_missing: error.code === "scope_missing",
    code: error.code,
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  validateCreate,
  buildGraphBody,
  isoOrNull,
  tokenize,
  scoreEvent,
  normalizeCalendarHit,
  clipCalendarSnippet,
  CALENDAR_SNIPPET_MAX,
  CALENDAR_DEFAULT_TOP_N,
  CALENDAR_TOP_N_CAP,
  CALENDAR_FETCH_TOP,
};
