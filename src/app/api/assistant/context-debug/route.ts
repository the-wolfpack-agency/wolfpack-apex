/**
 * GET /api/assistant/context-debug?q=<urlencoded question>
 *
 * Admin / capability-gated diagnostic endpoint that exposes EXACTLY what
 * `getRelevantContext({ question, userId, role, surface })` returned for
 * the calling user — without ever calling the LLM. It is intentionally
 * cheap so the user can hit it repeatedly to triage cases like:
 *
 *   "I asked the assistant about doc X. The LLM was reached
 *    (badge says '709 tokens') but it answered 'no information in
 *    the provided context'. So the system prompt got NO grounding.
 *    Why?"
 *
 * The answer is almost always one of:
 *   a) Graph token in the user's browser is missing `Sites.Read.All`
 *      (SharePoint search 403s — 0 hits, even though Azure shows the
 *      scope as granted to the app).
 *   b) SharePoint search returned hits but the rendered_prompt_block
 *      is empty due to a render / truncation bug.
 *   c) The doc literally isn't in the user's SharePoint search index.
 *
 * This endpoint surfaces the `ContextBundle` (sharepoint_hits[],
 * project_tasks[], meeting_notes[], rendered_prompt_block, total_chars,
 * took_ms, errors{}) so all three can be ruled in or out from a single
 * curl / browser hit.
 *
 * Auth: gated via `requireCapability(req, "assistant.use")` — the same
 * capability that gates `/api/assistant`. Anonymous calls 401, lacking-
 * capability calls 403, both are recorded as `system.capability_denied`
 * by the helper. Admin-only is intentionally NOT required: anyone who
 * can use the assistant can debug their own grounding context. The
 * delegated Graph token under the hood already enforces that the user
 * never sees another user's SharePoint content.
 *
 * Rate limit / cost: this route does NOT call any LLM. It only invokes
 * `getRelevantContext`, which fans out to:
 *   - SharePoint search (Graph; the calling user's delegated token)
 *   - MS Project / Planner / To Do task search (same)
 *   - Meeting transcript search (our DB)
 * — all of which are bounded and cheap. Safe to hit on every page load.
 *
 * IMPORTANT: We never log or persist the rendered_prompt_block content
 * here. It is returned to the caller, who is the same user the content
 * was authored for (Graph delegated token enforces that).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getRelevantContext,
  type ContextBundle,
  type ContextSurface,
} from "@/lib/assistant/context-resolver";

/**
 * Shape returned by this endpoint. Mirrors `ContextBundle` plus a
 * `failures_observed` array (flattened view of `bundle.errors`) and a
 * `user_id_hint` so the caller can confirm which Instinct identity the
 * diagnostic ran under (helpful when debugging "I'm logged in as Nick
 * but the token belongs to a different account").
 *
 * `failures_observed` exists so the user can scan one array for
 * "scope_missing: true" without having to remember the per-source
 * `errors.{sharepoint,project,meeting}` keys.
 */
export interface ContextDebugFailure {
  /** Which surface failed. Stable across SharePoint / Project / Meeting. */
  source: "sharepoint" | "project" | "meeting";
  /** HTTP-ish status (Graph 403/429/5xx; 0 for unexpected throws). */
  status: number;
  /** True when the failure indicates the user lacks the relevant Graph scope. */
  scope_missing: boolean;
  /** Discriminator from the source's error type; e.g. "scope_missing" or "rate_limited". */
  code?: string;
  /** Human-readable. NEVER user-controlled. */
  message?: string;
}

export interface ContextDebugResponse {
  question: string;
  surface: ContextSurface;
  took_ms: number;
  total_chars: number;
  sharepoint_hits: ContextBundle["sharepoint_hits"];
  project_tasks: ContextBundle["project_tasks"];
  meeting_notes: ContextBundle["meeting_notes"];
  rendered_prompt_block: string;
  failures_observed: ContextDebugFailure[];
  /** First 8 chars of the user id — enough to identify, not enough to leak. */
  user_id_hint: string;
  /** Static breadcrumb confirming this endpoint never invokes an LLM. */
  model_used_in_last_chat: string;
}

function flattenFailures(errors: ContextBundle["errors"]): ContextDebugFailure[] {
  if (!errors) return [];
  const out: ContextDebugFailure[] = [];
  if (errors.sharepoint) {
    out.push({
      source: "sharepoint",
      status: errors.sharepoint.status ?? 0,
      scope_missing: errors.sharepoint.code === "scope_missing",
      code: errors.sharepoint.code,
      message: errors.sharepoint.message,
    });
  }
  if (errors.project) {
    out.push({
      source: "project",
      status: errors.project.status ?? 0,
      scope_missing: errors.project.code === "scope_missing",
      code: errors.project.code,
      message: errors.project.message,
    });
  }
  if (errors.meeting) {
    out.push({
      source: "meeting",
      status: errors.meeting.status ?? 0,
      scope_missing: Boolean(errors.meeting.scope_missing),
      code: errors.meeting.code,
      message: errors.meeting.message,
    });
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "assistant.use");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    return NextResponse.json(
      { error: "q is required", hint: "GET /api/assistant/context-debug?q=<question>" },
      { status: 400 },
    );
  }

  // The assistant's primary surface today is `assistant_support`. We
  // expose `surface` as an optional override so the user can also
  // diagnose the `knowledge` surface from this same endpoint.
  const rawSurface = url.searchParams.get("surface");
  const surface: ContextSurface =
    rawSurface === "knowledge" ? "knowledge" : "assistant_support";

  const bundle = await getRelevantContext({
    question: q,
    userId: user.id,
    role: user.role,
    surface,
  });

  // Telemetry — separate from `assistant.context_resolved` which fires
  // inside the resolver itself. This event is the diagnostic signal:
  // "the user is debugging grounding". Helpful for triage dashboards.
  trackEvent("assistant.context_debug_invoked", user.id, user.role, {
    surface,
    sharepoint_count: bundle.sharepoint_hits.length,
    project_count: bundle.project_tasks.length,
    meeting_count: bundle.meeting_notes.length,
    total_chars: bundle.total_chars,
    failures_count: bundle.errors ? Object.keys(bundle.errors).length : 0,
    took_ms: bundle.took_ms,
  });

  const body: ContextDebugResponse = {
    question: bundle.question,
    surface: bundle.surface,
    took_ms: bundle.took_ms,
    total_chars: bundle.total_chars,
    sharepoint_hits: bundle.sharepoint_hits,
    project_tasks: bundle.project_tasks,
    meeting_notes: bundle.meeting_notes,
    rendered_prompt_block: bundle.rendered_prompt_block,
    failures_observed: flattenFailures(bundle.errors),
    user_id_hint: user.id.slice(0, 8),
    // Static string: this endpoint never calls an LLM. Naming it
    // explicitly so a reader of the response can confirm at a glance.
    model_used_in_last_chat: "(endpoint does not call an LLM)",
  };

  return NextResponse.json(body);
}
