/**
 * POST /api/feedback
 *
 * Persists a free-form feedback message into `instinct_user_feedback`
 * (migration 143) and emits the `assistant.feedback_recorded` event.
 *
 * Backs two paths:
 *   1. The widget-textarea path — when a user typed bare `/feedback`
 *      and the FeedbackWidget compose mode POSTs the typed message.
 *   2. Any future "feedback button" UI surface that wants to drop a
 *      thought without going through the assistant tool layer.
 *
 * Auth: `assistant.use` — same gate the rest of the assistant routes
 * use, since this is part of the assistant surface and the same role
 * set that can call `/api/assistant/chat` should be able to file
 * feedback.
 *
 * Rate limit: 3 / minute / user. Conservative — the table is cheap to
 * write to, but a runaway script would still spam the table and the
 * analytics topic. Mirrors the in-memory limiter pattern used by
 * /api/insights/meeting-prep and /api/mail/send; swap for Redis when
 * we go multi-replica.
 *
 * Failure modes:
 *   - unauth / wrong capability → 401 / 403 (via requireCapability).
 *   - missing/empty/oversized message → 400 with `error: "invalid_input"`.
 *   - rate-limited → 429 + Retry-After.
 *   - DB write failure → 500 (the lib re-throws WriteQueryError so the
 *     route knows the row didn't land — no silent 200 + lost data).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  recordUserFeedback,
  MAX_FEEDBACK_LENGTH,
} from "@/lib/feedback/record-feedback";

/* --------------------- Per-user rate limiter -------------------------- */

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 3;
const attempts = new Map<string, { count: number; windowStart: number }>();

export function _isRateLimited(
  userId: string,
  now = Date.now(),
): { limited: boolean; retryAfter: number } {
  const entry = attempts.get(userId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(userId, { count: 1, windowStart: now });
    return { limited: false, retryAfter: 0 };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    const retryAfter = Math.ceil(
      (WINDOW_MS - (now - entry.windowStart)) / 1000,
    );
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  entry.count++;
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  attempts.clear();
}

/* ------------------------------ POST --------------------------------- */

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "assistant.use");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { limited, retryAfter } = _isRateLimited(user.id);
  if (limited) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: { message?: unknown; surface?: unknown; workflow_id?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json(
      { error: "invalid_input", detail: "message is required" },
      { status: 400 },
    );
  }
  if (message.length > MAX_FEEDBACK_LENGTH) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: `message exceeds ${MAX_FEEDBACK_LENGTH} characters`,
      },
      { status: 400 },
    );
  }

  const surface =
    typeof body.surface === "string" && body.surface.trim()
      ? body.surface.trim().slice(0, 64)
      : undefined;
  const workflowId =
    typeof body.workflow_id === "string" && body.workflow_id.trim()
      ? body.workflow_id.trim()
      : undefined;

  const userAgent = req.headers.get("user-agent") ?? undefined;

  try {
    const out = await recordUserFeedback({
      workspaceId: user.workspaceId || "default",
      userId: user.id,
      userEmail: user.email,
      userRole: user.role,
      message,
      surface,
      userAgent,
      workflowId,
    });
    return NextResponse.json(
      { id: out.id, recorded_at: out.recordedAt },
      { status: 201 },
    );
  } catch (err) {
    console.error("[feedback route] write failed:", (err as Error).message);
    return NextResponse.json(
      { error: "internal", code: "write_failed" },
      { status: 500 },
    );
  }
}
