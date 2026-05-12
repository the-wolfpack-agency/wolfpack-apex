/**
 * Microsoft Online Meetings integration (Tier 2 · Stream E).
 *
 * Wraps Graph /me/onlineMeetings for create/update/get. Requires the
 * `OnlineMeetings.ReadWrite.All` delegated scope (added by Stream D to
 * MS_SCOPES).
 *
 * Every mutation:
 *   1. Calls Graph
 *   2. Upserts a row in instinct_online_meetings
 *   3. Records an audit entry (online_meeting.*)
 *   4. Emits a system.ms_online_meeting_{action} analytics event
 *
 * Tier 1 calendar integration: `attachTeamsMeetingToEventInput` creates a
 * standalone meeting and enriches a calendar event input with
 * `onlineMeetingProvider: "teamsForBusiness"` + the meeting payload. The
 * current `microsoft-calendar.ts` event path already supports the
 * `onlineMeetingProvider` field and `isOnlineMeeting` flag, so a future
 * small PR can wire this into the calendar create/update routes via an
 * opt-in `createTeamsMeeting: true` flag with NO changes to the calendar
 * library itself. That PR belongs to Stream A — this stream only ships
 * the helper.
 *
 * Never throws on expected Graph errors — returns Result<T>.
 */
 

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type MeetingErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "graph_error"
  | "internal";

export interface MeetingErrorResult {
  ok: false;
  code: MeetingErrorCode;
  scope?: string;
  retryAfter?: number;
  status?: number;
  message?: string;
}

export interface MeetingOkResult<T> {
  ok: true;
  value: T;
}

export type Result<T> = MeetingOkResult<T> | MeetingErrorResult;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateMeetingInput {
  subject: string;
  startAt: string; // ISO 8601
  endAt: string; // ISO 8601
  participants?: string[];
}

export interface UpdateMeetingInput {
  subject?: string;
  startAt?: string;
  endAt?: string;
  participants?: string[];
}

export interface CreatedMeeting {
  id: string;
  joinWebUrl: string | null;
  conferenceId: string | null;
}

export interface UpdatedMeeting {
  id: string;
}

export interface Meeting {
  id: string;
  userId: string;
  msMeetingId: string;
  msEventId: string | null;
  subject: string;
  startAt: string | null;
  endAt: string | null;
  joinWebUrl: string | null;
  conferenceId: string | null;
  audioConferencingTollNumber: string | null;
  participants: string[];
  createdAt: string;
  etag: string | null;
  syncedAt: string;
}

export interface TeamsMeetingEnrichment {
  onlineMeetingProvider: "teamsForBusiness";
  onlineMeeting: {
    id: string;
    joinUrl: string | null;
    conferenceId: string | null;
  };
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const AUDIT_SCOPE = "OnlineMeetings.ReadWrite.All";

interface GraphCallSuccess<T> {
  ok: true;
  status: number;
  data: T | null;
}

interface GraphCallError {
  ok: false;
  status: number;
  code: MeetingErrorCode;
  scope?: string;
  retryAfter?: number;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function classify403(body: any): {
  code: MeetingErrorCode;
  scope?: string;
  message: string;
} {
  const errCode = body?.error?.code || body?.error?.innerError?.code || "";
  const errMsg = body?.error?.message || "forbidden";
  const isScope =
    /AccessDenied/i.test(String(errCode)) ||
    /Authorization_RequestDenied/i.test(String(errCode)) ||
    /scope/i.test(errMsg) ||
    /permission/i.test(errMsg);
  if (isScope) {
    return { code: "scope_missing", scope: AUDIT_SCOPE, message: errMsg };
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
    return {
      ok: false,
      status: 0,
      code: "internal",
      message: `network_error: ${(err as Error).message}`,
    };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : 1;
    await sleep(retryAfter * 1000);
    let retry: Response;
    try {
      retry = await doCall();
    } catch (err) {
      return {
        ok: false,
        status: 0,
        code: "internal",
        retryAfter,
        message: `network_error_after_retry: ${(err as Error).message}`,
      };
    }
    if (retry.status === 429) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        retryAfter,
        message: "rate_limited_after_retry",
      };
    }
    res = retry;
  }

  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      code: "not_connected",
      message: "microsoft_not_connected",
    };
  }
  if (res.status === 403) {
    const b = await safeJson(res);
    const c = classify403(b);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: "not_found", message: "meeting_not_found" };
  }
  if (!res.ok) {
    const text = await safeText(res);
    return {
      ok: false,
      status: res.status,
      code: "graph_error",
      message: `graph_${res.status}: ${text.slice(0, 200)}`,
    };
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

function buildGraphBody(
  input: CreateMeetingInput | UpdateMeetingInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("subject" in input && input.subject !== undefined) body.subject = input.subject;
  if ("startAt" in input && input.startAt) body.startDateTime = input.startAt;
  if ("endAt" in input && input.endAt) body.endDateTime = input.endAt;
  if ("participants" in input && Array.isArray(input.participants)) {
    body.participants = {
      attendees: input.participants
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter((p) => p.length > 0)
        .map((upn) => ({ upn, role: "attendee" })),
    };
  }
  return body;
}

function validateCreate(input: CreateMeetingInput): MeetingErrorResult | null {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "invalid_input", message: "missing_body" };
  }
  if (!input.subject || input.subject.trim().length === 0) {
    return { ok: false, code: "invalid_input", message: "subject_required" };
  }
  if (!input.startAt || !input.endAt) {
    return { ok: false, code: "invalid_input", message: "start_end_required" };
  }
  const s = isoOrNull(input.startAt);
  const e = isoOrNull(input.endAt);
  if (!s || !e) {
    return { ok: false, code: "invalid_input", message: "invalid_date" };
  }
  if (new Date(e).getTime() <= new Date(s).getTime()) {
    return { ok: false, code: "invalid_input", message: "end_must_be_after_start" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache + audit
// ---------------------------------------------------------------------------

async function upsertMeetingRow(params: {
  userId: string;
  msMeetingId: string;
  msEventId?: string | null;
  subject: string;
  startAt: string | null;
  endAt: string | null;
  joinWebUrl: string | null;
  conferenceId: string | null;
  audioTollNumber: string | null;
  participants: string[];
  etag: string | null;
}): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO instinct_online_meetings
         (user_id, ms_meeting_id, ms_event_id, subject, start_at, end_at,
          join_web_url, conference_id, audio_conferencing_toll_number,
          participants, etag, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
       ON CONFLICT (user_id, ms_meeting_id) DO UPDATE SET
         ms_event_id = COALESCE(EXCLUDED.ms_event_id, instinct_online_meetings.ms_event_id),
         subject = EXCLUDED.subject,
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         join_web_url = EXCLUDED.join_web_url,
         conference_id = EXCLUDED.conference_id,
         audio_conferencing_toll_number = EXCLUDED.audio_conferencing_toll_number,
         participants = EXCLUDED.participants,
         etag = EXCLUDED.etag,
         synced_at = now()`,
      [
        params.userId,
        params.msMeetingId,
        params.msEventId ?? null,
        params.subject,
        params.startAt,
        params.endAt,
        params.joinWebUrl,
        params.conferenceId,
        params.audioTollNumber,
        JSON.stringify(params.participants),
        params.etag,
      ],
    );
  } catch (err) {
    console.warn(
      "[microsoft-online-meetings] upsert cache row failed:",
      (err as Error).message,
    );
  }
}

async function auditMeeting(params: {
  userId: string;
  role: string;
  action: string;
  msMeetingId: string;
  beforeState?: unknown;
  afterState?: unknown;
}): Promise<void> {
  try {
    await recordAudit({
      actor: { user_id: params.userId, role: params.role },
      action: params.action,
      resourceType: "online_meeting",
      resourceId: params.msMeetingId,
      beforeState: params.beforeState,
      afterState: params.afterState,
    });
  } catch (err) {
    console.warn(
      "[microsoft-online-meetings] audit record failed:",
      (err as Error).message,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createMeeting(
  userId: string,
  input: CreateMeetingInput,
  role = "system",
): Promise<Result<CreatedMeeting>> {
  const invalid = validateCreate(input);
  if (invalid) return invalid;

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_online_meeting_failed", userId, role, {
      op: "create",
      reason: "not_connected",
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const body = buildGraphBody(input);
  const res = await graphCall<any>("POST", "me/onlineMeetings", token.accessToken, body);

  if (!res.ok) {
    trackEvent("system.ms_online_meeting_failed", userId, role, {
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

  const id: string = res.data?.id ?? `meeting:${Date.now()}`;
  const joinWebUrl: string | null = res.data?.joinWebUrl ?? null;
  const conferenceId: string | null =
    res.data?.audioConferencing?.conferenceId ?? null;
  const tollNumber: string | null =
    res.data?.audioConferencing?.tollNumber ?? null;

  await upsertMeetingRow({
    userId,
    msMeetingId: id,
    msEventId: null,
    subject: input.subject,
    startAt: isoOrNull(input.startAt),
    endAt: isoOrNull(input.endAt),
    joinWebUrl,
    conferenceId,
    audioTollNumber: tollNumber,
    participants: input.participants ?? [],
    etag: null,
  });

  await auditMeeting({
    userId,
    role,
    action: "online_meeting.created",
    msMeetingId: id,
    afterState: {
      subject: input.subject,
      startAt: input.startAt,
      endAt: input.endAt,
      participants: input.participants ?? [],
    },
  });

  trackEvent("system.ms_online_meeting_created", userId, role, {
    meeting_id: id,
    participant_count: (input.participants ?? []).length,
    has_conference: conferenceId !== null,
  });

  return { ok: true, value: { id, joinWebUrl, conferenceId } };
}

export async function updateMeeting(
  userId: string,
  meetingId: string,
  patch: UpdateMeetingInput,
  role = "system",
): Promise<Result<UpdatedMeeting>> {
  if (!meetingId) {
    return { ok: false, code: "invalid_input", message: "meeting_id_required" };
  }
  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
    return { ok: false, code: "invalid_input", message: "empty_patch" };
  }
  if (patch.startAt && !isoOrNull(patch.startAt)) {
    return { ok: false, code: "invalid_input", message: "invalid_start" };
  }
  if (patch.endAt && !isoOrNull(patch.endAt)) {
    return { ok: false, code: "invalid_input", message: "invalid_end" };
  }

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_online_meeting_failed", userId, role, {
      op: "update",
      reason: "not_connected",
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const body = buildGraphBody(patch);
  const res = await graphCall<any>(
    "PATCH",
    `me/onlineMeetings/${encodeURIComponent(meetingId)}`,
    token.accessToken,
    body,
  );

  if (!res.ok) {
    trackEvent("system.ms_online_meeting_failed", userId, role, {
      op: "update",
      reason: res.code,
      status: res.status ?? 0,
      meeting_id: meetingId,
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

  const id: string = res.data?.id ?? meetingId;

  await upsertMeetingRow({
    userId,
    msMeetingId: id,
    subject: patch.subject ?? res.data?.subject ?? "",
    startAt: isoOrNull(patch.startAt ?? res.data?.startDateTime ?? null),
    endAt: isoOrNull(patch.endAt ?? res.data?.endDateTime ?? null),
    joinWebUrl: res.data?.joinWebUrl ?? null,
    conferenceId: res.data?.audioConferencing?.conferenceId ?? null,
    audioTollNumber: res.data?.audioConferencing?.tollNumber ?? null,
    participants: patch.participants ?? [],
    etag: null,
  });

  await auditMeeting({
    userId,
    role,
    action: "online_meeting.updated",
    msMeetingId: id,
    afterState: patch,
  });

  trackEvent("system.ms_online_meeting_updated", userId, role, {
    meeting_id: id,
    fields_changed: Object.keys(patch).join(","),
  });

  return { ok: true, value: { id } };
}

export async function getMeeting(
  userId: string,
  meetingId: string,
): Promise<Meeting | null> {
  if (!meetingId) return null;

  const token = await getValidToken(userId);
  if (token) {
    const res = await graphCall<any>(
      "GET",
      `me/onlineMeetings/${encodeURIComponent(meetingId)}`,
      token.accessToken,
    );
    if (res.ok && res.data) {
      return {
        id: res.data.id ?? meetingId,
        userId,
        msMeetingId: res.data.id ?? meetingId,
        msEventId: null,
        subject: res.data.subject ?? "",
        startAt: isoOrNull(res.data.startDateTime ?? null),
        endAt: isoOrNull(res.data.endDateTime ?? null),
        joinWebUrl: res.data.joinWebUrl ?? null,
        conferenceId: res.data.audioConferencing?.conferenceId ?? null,
        audioConferencingTollNumber: res.data.audioConferencing?.tollNumber ?? null,
        participants: Array.isArray(res.data.participants?.attendees)
          ? res.data.participants.attendees.map(
              (a: any) => a?.upn || a?.identity?.user?.id || "",
            )
          : [],
        createdAt:
          isoOrNull(res.data.creationDateTime ?? null) ?? new Date().toISOString(),
        etag: null,
        syncedAt: new Date().toISOString(),
      };
    }
  }

  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_meeting_id, ms_event_id, subject, start_at, end_at,
            join_web_url, conference_id, audio_conferencing_toll_number,
            participants, created_at, etag, synced_at
       FROM instinct_online_meetings
       WHERE user_id = $1 AND ms_meeting_id = $2
       LIMIT 1`,
    [userId, meetingId],
  );
  if (rows.length === 0) return null;
  return rowToMeeting(rows[0]);
}

export async function linkToEvent(
  userId: string,
  meetingId: string,
  eventId: string,
  role = "system",
): Promise<Result<void>> {
  if (!meetingId || !eventId) {
    return { ok: false, code: "invalid_input", message: "ids_required" };
  }
  if (!process.env.DATABASE_URL) return { ok: true, value: undefined };
  try {
    await query(
      `UPDATE instinct_online_meetings
          SET ms_event_id = $3, synced_at = now()
        WHERE user_id = $1 AND ms_meeting_id = $2`,
      [userId, meetingId, eventId],
    );
    await auditMeeting({
      userId,
      role,
      action: "online_meeting.linked",
      msMeetingId: meetingId,
      afterState: { ms_event_id: eventId },
    });
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      code: "internal",
      message: `link_failed: ${(err as Error).message}`,
    };
  }
}

export async function attachTeamsMeetingToEventInput(
  userId: string,
  eventInput: {
    subject: string;
    startAt: string;
    endAt: string;
    attendees?: string[];
  },
  role = "system",
): Promise<Result<TeamsMeetingEnrichment>> {
  const create = await createMeeting(
    userId,
    {
      subject: eventInput.subject,
      startAt: eventInput.startAt,
      endAt: eventInput.endAt,
      participants: eventInput.attendees,
    },
    role,
  );
  if (!create.ok) return create;
  return {
    ok: true,
    value: {
      onlineMeetingProvider: "teamsForBusiness",
      onlineMeeting: {
        id: create.value.id,
        joinUrl: create.value.joinWebUrl,
        conferenceId: create.value.conferenceId,
      },
    },
  };
}

function rowToMeeting(r: any): Meeting {
  return {
    id: r.id,
    userId: r.user_id,
    msMeetingId: r.ms_meeting_id,
    msEventId: r.ms_event_id,
    subject: r.subject ?? "",
    startAt: r.start_at ? new Date(r.start_at).toISOString() : null,
    endAt: r.end_at ? new Date(r.end_at).toISOString() : null,
    joinWebUrl: r.join_web_url,
    conferenceId: r.conference_id,
    audioConferencingTollNumber: r.audio_conferencing_toll_number,
    participants: Array.isArray(r.participants)
      ? r.participants
      : typeof r.participants === "string"
        ? JSON.parse(r.participants)
        : [],
    createdAt: new Date(r.created_at).toISOString(),
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

export const __internal = {
  validateCreate,
  buildGraphBody,
  isoOrNull,
};
