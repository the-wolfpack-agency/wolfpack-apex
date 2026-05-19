/**
 * GET /api/insights/meeting-prep?event_id=<id>
 *
 * Returns a cross-source synthesized pre-brief for the authenticated
 * user's meeting. Workspace-scoped (every read passes workspace_id).
 *
 * Cache contract — the route NEVER triggers a second LLM call. The
 * shared `prepareMeeting()` lib runs the fan-out + lookup, calls
 * synthesizePrep() exactly once on a cache miss, and persists the row.
 * Two teammates who hit this endpoint for the same meeting share the
 * same insight.
 *
 * Rate limited: 5 requests / minute / user. Conservative — the LLM is
 * only spent on cache misses, but the source fan-out (Graph mail per
 * attendee, CRM searches, brain queries) still costs real wall-clock
 * time. Same in-memory limiter pattern as /api/mail/send; swap for
 * Redis when we go multi-replica.
 *
 * Auth: requires `meetings.view`. Same capability the existing
 * /api/meetings/prebrief route already uses for the lighter-weight
 * composition path.
 *
 * Failure modes:
 *   - synthesis failure → 200 with `{ synthesis_unavailable: true,
 *     sources, ... }` so the widget can render raw sources instead of
 *     a hard error.
 *   - meeting not in calendar window → 404.
 *   - rate-limited → 429 with Retry-After.
 *   - unauth / capability → 401 / 403.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { prepareMeeting } from "@/lib/insights/meeting-prep";

/* --------------------- Per-user rate limiter -------------------------- */

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;
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
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  entry.count++;
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  attempts.clear();
}

/* ----------------------- Role-gate for regen ------------------------- */

const REGEN_ROLES = new Set(["cto", "ceo", "evp", "ops", "hr"]);

function canRegenerate(role: string | undefined): boolean {
  return !!role && REGEN_ROLES.has(role.toLowerCase());
}

/* ------------------------------ GET ----------------------------------- */

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { limited, retryAfter } = _isRateLimited(user.id);
  if (limited) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const url = new URL(req.url);
  const eventId = url.searchParams.get("event_id") || "";
  const force = url.searchParams.get("force") === "1";
  if (!eventId) {
    return NextResponse.json(
      { error: "invalid_input", detail: "event_id required" },
      { status: 400 },
    );
  }

  /* Server-side role gate: only managers+ can force-regenerate.
   * Returning 403 instead of silently downgrading so the UI surfaces
   * the missing scope cleanly. */
  if (force && !canRegenerate(user.role)) {
    return NextResponse.json(
      { error: "forbidden", code: "regenerate_role_required" },
      { status: 403 },
    );
  }

  const workspaceId = user.workspaceId || "default";

  let result;
  try {
    result = await prepareMeeting(eventId, {
      workspaceId,
      userId: user.id,
      userRole: user.role,
      force,
    });
  } catch (err) {
    /* prepareMeeting should never throw — defensive double-catch so a
     * stray rejection (e.g. an unexpected DB driver crash) still
     * returns a clean 500 to the user instead of an HTML error page. */
    console.error("[meeting-prep route] unexpected:", (err as Error).message);
    return NextResponse.json(
      { error: "internal", code: "unexpected" },
      { status: 500 },
    );
  }

  if (!result) {
    return NextResponse.json(
      { error: "not_found", detail: "meeting not in calendar window" },
      { status: 404 },
    );
  }

  void trackEvent("assistant.meeting_prep_executed", user.id, user.role, {
    meeting_id: eventId,
    workspace_id: workspaceId,
    cache_status: result.cacheStatus,
    synthesis_unavailable: result.synthesisUnavailable,
  });

  return NextResponse.json({
    prep: result.prep,
    sources: result.sources,
    cache_status: result.cacheStatus,
    generated_at: result.generatedAt,
    synthesis_unavailable: result.synthesisUnavailable,
    synthesis_error_code: result.synthesisErrorCode,
    viewer_can_regenerate: canRegenerate(user.role),
  });
}
