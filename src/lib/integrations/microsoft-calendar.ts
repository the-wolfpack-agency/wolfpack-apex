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
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken, type CalendarEvent } from "@/lib/microsoft-graph";
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
export async function listEvents(
  userId: string,
  opts: ListEventsOpts = {},
): Promise<CalendarEvent[]> {
  const token = await getValidToken(userId);
  if (!token) return [];

  const from = opts.from ? new Date(opts.from) : new Date();
  const to = opts.to ? new Date(opts.to) : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  const top = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  const endpoint =
    `me/calendarview?startDateTime=${encodeURIComponent(fromISO)}` +
    `&endDateTime=${encodeURIComponent(toISO)}` +
    `&$orderby=start/dateTime&$top=${top}` +
    `&$select=id,subject,start,end,location,attendees,isOnlineMeeting`;

  const res = await graphCall<{
    value?: {
      id: string;
      subject: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      location?: { displayName?: string };
      attendees?: { emailAddress: { name?: string; address: string } }[];
      isOnlineMeeting?: boolean;
    }[];
  }>("GET", endpoint, token.accessToken);

  if (!res.ok || !res.data?.value) return [];

  return res.data.value.map((ev) => {
    const rawAttendees = ev.attendees || [];
    return {
      id: ev.id,
      subject: ev.subject,
      start: ev.start.dateTime,
      end: ev.end.dateTime,
      location: ev.location?.displayName || "",
      attendees: rawAttendees.map((a) => a.emailAddress.name || a.emailAddress.address),
      attendeeEmails: rawAttendees
        .map((a) => (a.emailAddress.address || "").trim().toLowerCase())
        .filter((addr) => addr.includes("@")),
      isOnlineMeeting: ev.isOnlineMeeting || false,
    };
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  validateCreate,
  buildGraphBody,
  isoOrNull,
};
