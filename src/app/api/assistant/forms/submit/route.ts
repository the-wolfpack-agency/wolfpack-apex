/**
 * POST /api/assistant/forms/submit
 *
 * Single entry point for chat-action form submissions. Body:
 *   { formKind: "create_email" | "create_message" | "create_calendar_event" | "create_task",
 *     fields: { ... } }
 *
 * Dispatches to the existing backend endpoint for the given formKind.
 * Each kind has its own validator + adapter — we never blindly forward
 * the fields object to MS Graph; we re-shape it into the upstream
 * route's expected schema.
 *
 * Why a proxy vs. the client POSTing directly to /api/mail/send:
 *   1. Single CSRF / auth gate.
 *   2. Uniform analytics ("assistant.form_submitted" + per-kind).
 *   3. The chat surface doesn't need to know each upstream's body
 *      shape — that's a leaky-abstraction footgun.
 *   4. Future: orchestration (e.g. create event THEN send invite
 *      email) gets composed here, not in the UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import type { InstinctEventType } from "@/lib/analytics";
import type {
  FormKind,
  FormSubmitResult,
} from "@/lib/assistant/forms/types";

/* Lookup table — keeps the per-kind event names in one place AND
 * satisfies the InstinctEventType union without resorting to string
 * concatenation (which TS rejects as too-wide). */
const PER_KIND_SUCCESS_EVENT: Record<FormKind, InstinctEventType> = {
  create_email: "assistant.form_create_email_submitted",
  create_message: "assistant.form_create_message_submitted",
  create_calendar_event: "assistant.form_create_calendar_event_submitted",
  create_task: "assistant.form_create_task_submitted",
};

interface SubmitBody {
  formKind?: unknown;
  fields?: unknown;
}

const KNOWN_KINDS: FormKind[] = [
  "create_email",
  "create_message",
  "create_calendar_event",
  "create_task",
];

function failure(
  code: "validation" | "auth" | "scope" | "rate_limit" | "internal",
  message: string,
  fieldErrors?: Record<string, string>,
): NextResponse {
  const body: FormSubmitResult = { ok: false, code, message };
  if (fieldErrors) body.fieldErrors = fieldErrors;
  const status =
    code === "auth" ? 401 :
    code === "scope" ? 403 :
    code === "rate_limit" ? 429 :
    code === "validation" ? 400 :
    500;
  return NextResponse.json(body, { status });
}

function success(message: string, resourceId?: string, resourceUrl?: string): NextResponse {
  const body: FormSubmitResult = { ok: true, message };
  if (resourceId) body.resourceId = resourceId;
  if (resourceUrl) body.resourceUrl = resourceUrl;
  return NextResponse.json(body);
}

/* Helper: re-call our own Next API routes from the server side so we
 * inherit their auth + capability checks instead of duplicating them.
 * The Authorization header forwards through. */
async function forwardJson(
  origin: string,
  authHeader: string | null,
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body is fine; surface the status only */
  }
  return { status: res.status, data };
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return failure("auth", "Unauthorized");

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return failure("validation", "Invalid JSON body");
  }

  const kind = body.formKind;
  if (typeof kind !== "string" || !KNOWN_KINDS.includes(kind as FormKind)) {
    return failure(
      "validation",
      `Unknown formKind: ${typeof kind === "string" ? kind : "missing"}`,
    );
  }
  const fields = (body.fields ?? {}) as Record<string, string>;

  const started = Date.now();
  const origin = req.nextUrl.origin;
  const authHeader = req.headers.get("authorization");

  try {
    let response: NextResponse;
    switch (kind as FormKind) {
      case "create_email":
        response = await submitEmail(origin, authHeader, fields);
        break;
      case "create_message":
        response = await submitMessage(origin, authHeader, fields);
        break;
      case "create_calendar_event":
        response = await submitCalendarEvent(origin, authHeader, fields);
        break;
      case "create_task":
        response = await submitTask(origin, authHeader, fields);
        break;
      default:
        response = failure("internal", `Unrouted formKind: ${kind}`);
    }
    const respPayload = await response
      .clone()
      .json()
      .catch(() => ({}));
    trackEvent("assistant.form_submitted", user.id, user.role, {
      form_kind: kind,
      ok: response.status >= 200 && response.status < 300,
      duration_ms: Date.now() - started,
      http_status: response.status,
    });
    /* Per-form-kind analytics so each action shows up on its own
     * dashboard line. */
    if (response.status >= 200 && response.status < 300) {
      const eventName = PER_KIND_SUCCESS_EVENT[kind as FormKind];
      trackEvent(eventName, user.id, user.role, {
        ok: true,
        resource_id: typeof (respPayload as { resourceId?: string }).resourceId === "string"
          ? (respPayload as { resourceId: string }).resourceId
          : "",
      });
    }
    return response;
  } catch (err) {
    trackEvent("assistant.form_submitted", user.id, user.role, {
      form_kind: kind,
      ok: false,
      duration_ms: Date.now() - started,
      error: (err as Error).message.slice(0, 200),
    });
    return failure("internal", `Submit failed: ${(err as Error).message}`);
  }
}

/* ---------------------------------------------------------------------
 * Per-form-kind submitters. Each one validates fields, re-shapes into
 * the upstream POST body, forwards, and converts the upstream response
 * into a FormSubmitResult.
 * ------------------------------------------------------------------- */

async function submitEmail(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
): Promise<NextResponse> {
  const to = (fields.to ?? "").trim();
  const subject = (fields.subject ?? "").trim();
  const bodyText = (fields.body ?? "").trim();
  const cc = (fields.cc ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!to) fieldErrors.to = "Required";
  if (!subject) fieldErrors.subject = "Required";
  if (!bodyText) fieldErrors.body = "Required";
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Some required fields are missing.", fieldErrors);
  }

  const splitAddrs = (raw: string) =>
    raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const { status, data } = await forwardJson(origin, authHeader, "/api/mail/send", {
    to: splitAddrs(to),
    ...(cc ? { cc: splitAddrs(cc) } : {}),
    subject,
    bodyText,
  });
  if (status === 401) return failure("auth", "Microsoft account not connected.");
  if (status === 403) return failure("scope", "Email send permission not granted.");
  if (status === 429) return failure("rate_limit", "Too many emails — try again shortly.");
  if (status >= 400) {
    return failure(
      "internal",
      typeof (data as { detail?: string })?.detail === "string"
        ? (data as { detail: string }).detail
        : "Email send failed.",
    );
  }
  return success(`Sent email to ${to}.`);
}

async function submitMessage(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
): Promise<NextResponse> {
  const chatId = (fields.chatId ?? "").trim();
  const messageBody = (fields.body ?? "").trim();
  const fieldErrors: Record<string, string> = {};
  if (!chatId) fieldErrors.chatId = "Required";
  if (!messageBody) fieldErrors.body = "Required";
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Some required fields are missing.", fieldErrors);
  }

  const { status, data } = await forwardJson(
    origin,
    authHeader,
    `/api/ms/chats/${encodeURIComponent(chatId)}/messages`,
    { content: messageBody, contentType: "text" },
  );
  if (status === 401) return failure("auth", "Microsoft account not connected.");
  if (status === 403) return failure("scope", "Teams message permission not granted.");
  if (status === 429) return failure("rate_limit", "Too many messages — try again shortly.");
  if (status === 404) {
    return failure("validation", "Teams chat not found.", { chatId: "Chat not found" });
  }
  if (status >= 400) {
    return failure(
      "internal",
      typeof (data as { error?: string })?.error === "string"
        ? (data as { error: string }).error
        : "Teams message send failed.",
    );
  }
  return success("Sent your Teams message.");
}

async function submitCalendarEvent(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
): Promise<NextResponse> {
  const subject = (fields.subject ?? "").trim();
  const start = (fields.start ?? "").trim();
  const end = (fields.end ?? "").trim();
  const attendeesRaw = (fields.attendees ?? "").trim();
  const bodyText = (fields.body ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!subject) fieldErrors.subject = "Required";
  if (!start) fieldErrors.start = "Required";
  if (!end) fieldErrors.end = "Required";
  if (start && end && Date.parse(start) >= Date.parse(end)) {
    fieldErrors.end = "End must be after start";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Check the highlighted fields.", fieldErrors);
  }

  const attendees = attendeesRaw
    ? attendeesRaw.split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  const { status, data } = await forwardJson(origin, authHeader, "/api/calendar/events", {
    subject,
    start,
    end,
    ...(attendees && attendees.length > 0 ? { attendees } : {}),
    ...(bodyText ? { bodyText } : {}),
  });
  if (status === 401) return failure("auth", "Microsoft account not connected.");
  if (status === 403) return failure("scope", "Calendar permission not granted.");
  if (status === 429) return failure("rate_limit", "Too many requests — try again shortly.");
  if (status >= 400) {
    return failure(
      "internal",
      typeof (data as { detail?: string })?.detail === "string"
        ? (data as { detail: string }).detail
        : "Calendar event create failed.",
    );
  }
  const eventId = typeof (data as { id?: string })?.id === "string"
    ? (data as { id: string }).id
    : undefined;
  return success(`Created event "${subject}".`, eventId);
}

async function submitTask(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
): Promise<NextResponse> {
  const title = (fields.title ?? "").trim();
  const taskBody = (fields.body ?? "").trim();
  const dueAt = (fields.dueAt ?? "").trim();
  const importance = (fields.importance ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!title) fieldErrors.title = "Required";
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Title is required.", fieldErrors);
  }

  /* The tasks endpoint requires a listId. For the Assistant we resolve
   * the user's default list server-side — that lookup lives in
   * /api/tasks/lists. To keep this proxy focused we forward an empty
   * listId and let the upstream route's default-list resolver handle
   * it. If the upstream complains, we surface a helpful error. */
  const { status, data } = await forwardJson(origin, authHeader, "/api/tasks", {
    listId: "default",
    title,
    ...(taskBody ? { body: taskBody } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(importance ? { importance } : {}),
  });
  if (status === 401) return failure("auth", "Microsoft account not connected.");
  if (status === 429) return failure("rate_limit", "Too many requests — try again shortly.");
  if (status >= 400) {
    const detail = (data as { error?: string; detail?: string })?.detail
      ?? (data as { error?: string; detail?: string })?.error;
    return failure(
      "internal",
      typeof detail === "string" ? detail : "Task create failed.",
    );
  }
  const taskId = typeof (data as { task?: { id?: string } })?.task?.id === "string"
    ? (data as { task: { id: string } }).task.id
    : undefined;
  return success(`Created task "${title}".`, taskId);
}
