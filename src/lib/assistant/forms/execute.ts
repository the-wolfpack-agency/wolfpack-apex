/**
 * Shared form-action executor.
 *
 * Single source of truth for "given a form kind + fields + caller
 * context, perform the underlying action and return a typed
 * FormSubmitResult Response". Both the human submit route
 * (`/api/assistant/forms/submit`) and the (future) agent on-behalf
 * path drive form actions through this one module so the per-kind
 * field mapping, upstream paths, and error translation live in exactly
 * one place (DRY).
 *
 * Each kind validates fields, re-shapes them into the upstream POST
 * body, forwards (carrying the caller's Authorization header exactly as
 * received, we never construct, parse, or log tokens), and converts
 * the upstream response into a FormSubmitResult.
 *
 * Security: the caller passes a trusted server origin (NOT a
 * request-derived Host) and the caller's auth header verbatim. The
 * executor forwards that header unchanged; it does not mint or inspect
 * credentials. See the route handler for where `origin` is resolved
 * (`resolveInternalOrigin`) and why a spoofed Host would be a CWE-918
 * request-forgery risk.
 */

import { NextResponse } from "next/server";
import type { FormKind, FormSubmitResult } from "@/lib/assistant/forms/types";
import {
  buildRestConnectorForWorkspace,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import { internalFetch } from "@/lib/http/internal-fetch";

export type { FormKind } from "@/lib/assistant/forms/types";

/** The form kinds the executor knows how to dispatch. Mirrors the
 *  FormKind union; exported so callers validate against one list. */
export const KNOWN_FORM_KINDS: FormKind[] = [
  "create_email",
  "create_message",
  "create_calendar_event",
  "create_task",
  "create_okr",
  "create_feature",
  "create_crm_record",
];

/** Context every executed action needs: a trusted server origin, the
 *  caller's auth header (forwarded verbatim, never logged), and an
 *  optional `extra` bag for kind-specific args (e.g. CRM workspaceId). */
export interface ExecuteContext {
  origin: string;
  authHeader: string | null;
  extra?: Record<string, unknown>;
}

export function failure(
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

export function success(message: string, resourceId?: string, resourceUrl?: string): NextResponse {
  const body: FormSubmitResult = { ok: true, message };
  if (resourceId) body.resourceId = resourceId;
  if (resourceUrl) body.resourceUrl = resourceUrl;
  return NextResponse.json(body);
}

/* Helper: re-call our own Next API routes from the server side so we
 * inherit their auth + capability checks instead of duplicating them.
 * The Authorization header forwards through. Transport goes through the
 * shared internalFetch so the Vercel deployment-protection bypass header,
 * the transient-throw retry, and the diagnosable error message apply here
 * too (the fix for the prod "fetch failed" self-call bug). The status /
 * JSON translation below is unchanged. */
async function forwardJson(
  origin: string,
  authHeader: string | null,
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await internalFetch(path, {
    originOverride: origin,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body is fine; surface the status only */
  }
  return { status: res.status, data };
}

/**
 * Execute a form action by kind. Switches on `kind`, runs the matching
 * per-kind adapter, and returns the adapter's Response. The caller owns
 * analytics + outer error handling so ordering stays identical to the
 * pre-refactor route (this stays pure of analytics).
 */
export async function executeFormAction(
  kind: FormKind,
  fields: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<Response> {
  const { origin, authHeader } = ctx;
  /* The per-kind adapters were written against string-valued fields
   * (every value arrives as a form-input string). Keep that contract. */
  const stringFields = fields as Record<string, string>;
  switch (kind) {
    case "create_email":
      return submitEmail(origin, authHeader, stringFields);
    case "create_message":
      return submitMessage(origin, authHeader, stringFields);
    case "create_calendar_event":
      return submitCalendarEvent(origin, authHeader, stringFields);
    case "create_task":
      return submitTask(origin, authHeader, stringFields);
    case "create_okr":
      return submitOkr(origin, authHeader, stringFields);
    case "create_feature":
      return submitFeature(origin, authHeader, stringFields);
    case "create_crm_record": {
      const workspaceId =
        typeof ctx.extra?.workspaceId === "string"
          ? (ctx.extra.workspaceId as string)
          : "default";
      /* agentId (set by the agent on-behalf path) scopes the connector to the
         agent's bound set. Absent on the human submit route → unchanged. */
      const agentId =
        typeof ctx.extra?.agentId === "string"
          ? (ctx.extra.agentId as string)
          : undefined;
      return submitCrmRecord(origin, authHeader, stringFields, workspaceId, agentId);
    }
    default:
      return failure("internal", `Unrouted formKind: ${kind}`);
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
  if (status === 429) return failure("rate_limit", "Too many emails, try again shortly.");
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
  /* Accepts either { recipient } (display name or email, resolved
     server-side via the directory) OR { chatId } (legacy / power-user
     path). recipient wins when both are set. */
  const recipient = (fields.recipient ?? "").trim();
  const chatIdRaw = (fields.chatId ?? "").trim();
  const messageBody = (fields.body ?? "").trim();
  const fieldErrors: Record<string, string> = {};
  if (!recipient && !chatIdRaw) fieldErrors.recipient = "Required";
  if (!messageBody) fieldErrors.body = "Required";
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Some required fields are missing.", fieldErrors);
  }

  let chatId = chatIdRaw;
  if (!chatId && recipient) {
    /* Find an existing 1:1 chat where the other party matches the
       recipient by display name or email. We forward to GET /api/ms/chats
       (the list endpoint already auth-gates per-user) and pick the
       first match. Future: Graph users.search + chats.create for users
       who've never DM'd the recipient before. */
    const url = `/api/ms/chats?match=${encodeURIComponent(recipient)}`;
    let listRes: Response;
    try {
      /* Same shared transport as forwardJson: deployment-protection bypass +
         transient-throw retry + diagnosable error. Auth header forwarded
         verbatim. The match / status handling below is unchanged. */
      listRes = await internalFetch(url, {
        originOverride: origin,
        init: {
          method: "GET",
          headers: { ...(authHeader ? { Authorization: authHeader } : {}) },
        },
      });
    } catch (err) {
      return failure("internal", `Failed to look up recipient: ${(err as Error).message}`);
    }
    if (listRes.status === 401) {
      return failure("auth", "Microsoft account not connected.");
    }
    if (listRes.status === 403) {
      return failure("scope", "Teams chat list permission not granted.");
    }
    if (!listRes.ok) {
      return failure(
        "internal",
        `Couldn't look up Teams chats (HTTP ${listRes.status}).`,
      );
    }
    const body = (await listRes.json().catch(() => ({}))) as {
      chats?: Array<{
        id: string;
        chatType?: string;
        topic?: string;
        members?: Array<{ displayName?: string; email?: string }>;
      }>;
    };
    const wanted = recipient.toLowerCase();
    const match = (body.chats ?? []).find((c) => {
      const inTopic = (c.topic ?? "").toLowerCase().includes(wanted);
      const inMember = (c.members ?? []).some(
        (m) =>
          (m.displayName ?? "").toLowerCase().includes(wanted) ||
          (m.email ?? "").toLowerCase() === wanted,
      );
      return inTopic || inMember;
    });
    if (!match) {
      return failure(
        "validation",
        "No existing Teams chat with that person. Open Teams and start a chat first, then try again.",
        { recipient: "No matching chat" },
      );
    }
    chatId = match.id;
  }

  const { status, data } = await forwardJson(
    origin,
    authHeader,
    `/api/ms/chats/${encodeURIComponent(chatId)}/messages`,
    { content: messageBody, contentType: "text" },
  );
  if (status === 401) return failure("auth", "Microsoft account not connected.");
  if (status === 403) return failure("scope", "Teams message permission not granted.");
  if (status === 429) return failure("rate_limit", "Too many messages, try again shortly.");
  if (status === 404) {
    return failure("validation", "Teams chat not found.", { recipient: "Chat not found" });
  }
  if (status >= 400) {
    return failure(
      "internal",
      typeof (data as { error?: string })?.error === "string"
        ? (data as { error: string }).error
        : "Teams message send failed.",
    );
  }
  return success(
    recipient
      ? `Sent your Teams message to ${recipient}.`
      : "Sent your Teams message.",
  );
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
  if (status === 429) return failure("rate_limit", "Too many requests, try again shortly.");
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
  const listId = (fields.listId ?? "").trim();
  const taskBody = (fields.body ?? "").trim();
  const dueAt = (fields.dueAt ?? "").trim();
  const importance = (fields.importance ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!title) fieldErrors.title = "Required";
  /* "default" was a sentinel sent by older form specs that the upstream
   * route can't resolve, Graph rejects it with ErrorInvalidIdMalformed.
   * Reject early so the user sees the right "pick a list" message. */
  if (!listId || listId === "default") {
    fieldErrors.listId =
      "Pick a To-Do list. If none appear, sync from the Tasks page first.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Check the highlighted fields.", fieldErrors);
  }

  const { status, data } = await forwardJson(origin, authHeader, "/api/tasks", {
    listId,
    title,
    ...(taskBody ? { body: taskBody } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(importance ? { importance } : {}),
  });
  if (status === 401) return failure("auth", "Microsoft account not connected.");
  if (status === 429) return failure("rate_limit", "Too many requests, try again shortly.");
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

async function submitOkr(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
): Promise<NextResponse> {
  const quarter = (fields.quarter ?? "").trim();
  const objective = (fields.objective ?? "").trim();
  const krMetric = (fields.kr_metric ?? "").trim();
  const krTargetRaw = (fields.kr_target ?? "").trim();
  const krUnit = (fields.kr_unit ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!quarter) fieldErrors.quarter = "Required";
  if (!objective) fieldErrors.objective = "Required";
  if (!krMetric) fieldErrors.kr_metric = "Required";
  if (!krTargetRaw) fieldErrors.kr_target = "Required";
  const krTarget = Number(krTargetRaw);
  if (krTargetRaw && !Number.isFinite(krTarget)) {
    fieldErrors.kr_target = "Must be a number";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Check the highlighted fields.", fieldErrors);
  }

  const { status, data } = await forwardJson(origin, authHeader, "/api/goals/okrs", {
    quarter,
    objective,
    krs: [
      {
        metric: krMetric,
        target: krTarget,
        ...(krUnit ? { unit: krUnit } : {}),
      },
    ],
  });
  if (status === 401) return failure("auth", "Sign in first.");
  if (status === 403) {
    return failure(
      "scope",
      "Only CEO / CTO / EVP roles can create OKRs.",
    );
  }
  if (status >= 400) {
    return failure(
      "internal",
      typeof (data as { error?: string })?.error === "string"
        ? (data as { error: string }).error
        : "OKR create failed.",
    );
  }
  const okrId = typeof (data as { okr?: { id?: string } })?.okr?.id === "string"
    ? (data as { okr: { id: string } }).okr.id
    : undefined;
  return success(`Created OKR for ${quarter}.`, okrId);
}

async function submitFeature(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
): Promise<NextResponse> {
  const title = (fields.title ?? "").trim();
  const description = (fields.description ?? "").trim();
  const targetProduct = (fields.target_product ?? "").trim();
  const priority = (fields.priority ?? "").trim();
  const category = (fields.category ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!title) fieldErrors.title = "Required";
  if (!description) fieldErrors.description = "Required";
  if (Object.keys(fieldErrors).length > 0) {
    return failure("validation", "Title and description are required.", fieldErrors);
  }

  const { status, data } = await forwardJson(origin, authHeader, "/api/features", {
    title,
    description,
    ...(targetProduct ? { target_product: targetProduct } : {}),
    ...(priority ? { priority } : {}),
    ...(category ? { category } : {}),
  });
  if (status === 401) return failure("auth", "Sign in first.");
  if (status >= 400) {
    return failure(
      "internal",
      typeof (data as { error?: string })?.error === "string"
        ? (data as { error: string }).error
        : "Feature request submit failed.",
    );
  }
  const featureId = typeof (data as { id?: string })?.id === "string"
    ? (data as { id: string }).id
    : undefined;
  return success(`Submitted feature request: "${title}".`, featureId);
}

async function submitCrmRecord(
  origin: string,
  authHeader: string | null,
  fields: Record<string, string>,
  workspaceId: string = "default",
  agentId?: string,
): Promise<NextResponse> {
  /* The CRM form is vendor-aware: required fields vary by objectType.
     We validate per-type, then forward to the existing connector
     write endpoint that already routes by workspace connector. */
  const objectType = (fields.objectType ?? "deal").trim();
  const fieldErrors: Record<string, string> = {};
  const payload: Record<string, unknown> = { objectType };

  if (objectType === "deal") {
    const name = (fields.name ?? "").trim();
    const amountRaw = (fields.amount ?? "").trim();
    const stage = (fields.stage ?? "").trim();
    const closeDate = (fields.closeDate ?? "").trim();
    if (!name) fieldErrors.name = "Required";
    if (!amountRaw) fieldErrors.amount = "Required";
    if (!stage) fieldErrors.stage = "Required";
    if (!closeDate) fieldErrors.closeDate = "Required";
    const amount = Number(amountRaw.replace(/[$,]/g, ""));
    if (amountRaw && !Number.isFinite(amount)) {
      fieldErrors.amount = "Must be a number";
    }
    if (Object.keys(fieldErrors).length > 0) {
      return failure("validation", "Check the highlighted fields.", fieldErrors);
    }
    payload.fields = {
      Name: name,
      Amount: amount,
      StageName: stage,
      CloseDate: closeDate,
      ...(fields.accountName ? { AccountName: fields.accountName } : {}),
    };
  } else if (objectType === "contact") {
    const lastName = (fields.lastName ?? "").trim();
    if (!lastName) fieldErrors.lastName = "Required";
    if (Object.keys(fieldErrors).length > 0) {
      return failure("validation", "Last name is required.", fieldErrors);
    }
    payload.fields = {
      LastName: lastName,
      ...(fields.firstName ? { FirstName: fields.firstName } : {}),
      ...(fields.email ? { Email: fields.email } : {}),
      ...(fields.accountName ? { AccountName: fields.accountName } : {}),
    };
  } else if (objectType === "account") {
    const name = (fields.name ?? "").trim();
    if (!name) fieldErrors.name = "Required";
    if (Object.keys(fieldErrors).length > 0) {
      return failure("validation", "Account name is required.", fieldErrors);
    }
    payload.fields = {
      Name: name,
      ...(fields.industry ? { Industry: fields.industry } : {}),
      ...(fields.website ? { Website: fields.website } : {}),
    };
  } else if (objectType === "task") {
    const subject = (fields.subject ?? "").trim();
    if (!subject) fieldErrors.subject = "Required";
    if (Object.keys(fieldErrors).length > 0) {
      return failure("validation", "Subject is required.", fieldErrors);
    }
    payload.fields = {
      Subject: subject,
      ...(fields.dueDate ? { ActivityDate: fields.dueDate } : {}),
      ...(fields.type ? { Type: fields.type } : {}),
    };
  } else {
    return failure("validation", `Unknown CRM object type: ${objectType}`);
  }

  /* Call the connector directly (same code path the legacy
     create_external_record tool uses). No HTTP hop because there's
     no public API endpoint for this; the assistant owns CRM writes
     server-side. */
  /* Least-privilege: when this CRM write is driven by an agent (agentId set),
     the pick + build are scoped to the agent's bound set. An unbound connector
     surfaces as a scope failure rather than touching the credential. The human
     submit route (no agentId) resolves byte-for-byte as before. */
  const connectorName =
    (agentId
      ? await pickConfiguredConnector(workspaceId, agentId)
      : await pickConfiguredConnector(workspaceId)) ?? "rest-default";
  let connector: Awaited<ReturnType<typeof buildRestConnectorForWorkspace>>;
  try {
    connector = agentId
      ? await buildRestConnectorForWorkspace(workspaceId, connectorName, agentId)
      : await buildRestConnectorForWorkspace(workspaceId, connectorName);
  } catch (err) {
    return failure(
      "scope",
      (err as Error).message ||
        "This agent is not authorized to use that CRM connector.",
    );
  }
  if (!connector.isConfigured()) {
    return failure(
      "validation",
      `The ${connectorName} CRM connector isn't configured. Connect Salesforce or HubSpot from /admin/connectors first.`,
    );
  }
  if (typeof connector.createRecord !== "function") {
    return failure("internal", `Connector "${connectorName}" does not support writes.`);
  }
  const result = await connector.createRecord(
    objectType === "deal" ? "deal" : objectType,
    payload.fields as Record<string, unknown>,
  );
  if (!result.ok) {
    if (result.code === "auth_failed") {
      return failure("auth", "CRM connection expired. Reconnect from /admin/connectors.");
    }
    return failure(
      "internal",
      result.message ?? `CRM write failed.`,
    );
  }
  return success(
    `Created ${objectType} in ${connectorName === "rest-default" ? "your CRM" : connectorName}.`,
    typeof result.data?.id === "string" ? result.data.id : undefined,
  );
}
