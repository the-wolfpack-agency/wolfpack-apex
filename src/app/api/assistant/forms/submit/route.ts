/**
 * POST /api/assistant/forms/submit
 *
 * Single entry point for chat-action form submissions. Body:
 *   { formKind: "create_email" | "create_message" | "create_calendar_event" | "create_task",
 *     fields: { ... } }
 *
 * Dispatches to the existing backend endpoint for the given formKind.
 * Each kind has its own validator + adapter, we never blindly forward
 * the fields object to MS Graph; we re-shape it into the upstream
 * route's expected schema.
 *
 * Why a proxy vs. the client POSTing directly to /api/mail/send:
 *   1. Single CSRF / auth gate.
 *   2. Uniform analytics ("assistant.form_submitted" + per-kind).
 *   3. The chat surface doesn't need to know each upstream's body
 *      shape, that's a leaky-abstraction footgun.
 *   4. Future: orchestration (e.g. create event THEN send invite
 *      email) gets composed here, not in the UI.
 */

import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { resolveInternalOrigin } from "@/lib/qr/origin";
import { trackEvent } from "@/lib/analytics";
import type { InstinctEventType } from "@/lib/analytics";
import type { FormKind } from "@/lib/assistant/forms/types";
import {
  executeFormAction,
  KNOWN_FORM_KINDS,
  failure,
} from "@/lib/assistant/forms/execute";

/* Lookup table, keeps the per-kind event names in one place AND
 * satisfies the InstinctEventType union without resorting to string
 * concatenation (which TS rejects as too-wide). */
const PER_KIND_SUCCESS_EVENT: Record<FormKind, InstinctEventType> = {
  create_email: "assistant.form_create_email_submitted",
  create_message: "assistant.form_create_message_submitted",
  create_calendar_event: "assistant.form_create_calendar_event_submitted",
  create_task: "assistant.form_create_task_submitted",
  create_okr: "assistant.form_create_okr_submitted",
  create_feature: "assistant.form_create_feature_submitted",
  create_crm_record: "assistant.form_create_crm_record_submitted",
};

interface SubmitBody {
  formKind?: unknown;
  fields?: unknown;
  workflowId?: unknown;
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
  if (typeof kind !== "string" || !KNOWN_FORM_KINDS.includes(kind as FormKind)) {
    return failure(
      "validation",
      `Unknown formKind: ${typeof kind === "string" ? kind : "missing"}`,
    );
  }
  const fields = (body.fields ?? {}) as Record<string, string>;
  /* Optional per-turn correlation id forwarded by the chat client.
   * When present, every per-kind analytics event we fire below
   * carries workflow_id so funnels reconstruct end-to-end. */
  const workflowId = typeof body.workflowId === "string" ? body.workflowId : undefined;

  const started = Date.now();
  /* Trusted server-configured origin, NOT req.nextUrl.origin. These
   * helpers re-call our own API routes forwarding the caller's bearer;
   * trusting the (attacker-controllable) Host header would let a spoofed
   * Host exfiltrate the token (CWE-918 request-forgery). */
  const origin = resolveInternalOrigin();
  const authHeader = req.headers.get("authorization");

  try {
    /* All per-kind dispatch + field mapping lives in the shared
     * executor so the (future) agent on-behalf path runs the exact
     * same code (DRY). We forward the caller's auth header verbatim and
     * a trusted server origin; CRM needs the workspace id via `extra`. */
    const response = await executeFormAction(kind as FormKind, fields, {
      origin,
      authHeader,
      extra: {
        workspaceId: (user as { workspaceId?: string }).workspaceId ?? "default",
      },
    });
    const respPayload = await response
      .clone()
      .json()
      .catch(() => ({}));
    trackEvent("assistant.form_submitted", user.id, user.role, {
      form_kind: kind,
      ok: response.status >= 200 && response.status < 300,
      duration_ms: Date.now() - started,
      http_status: response.status,
      ...(workflowId ? { workflow_id: workflowId } : {}),
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
        ...(workflowId ? { workflow_id: workflowId } : {}),
      });
    }
    return response;
  } catch (err) {
    trackEvent("assistant.form_submitted", user.id, user.role, {
      form_kind: kind,
      ok: false,
      duration_ms: Date.now() - started,
      error: (err as Error).message.slice(0, 200),
      ...(workflowId ? { workflow_id: workflowId } : {}),
    });
    return failure("internal", `Submit failed: ${(err as Error).message}`);
  }
}
