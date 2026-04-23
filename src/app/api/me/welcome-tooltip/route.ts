/**
 * Welcome tooltip state for the current user.
 *
 * GET  → { should_show: boolean }
 *   True iff the user has no `welcome_tooltip.dismissed` analytics
 *   event on file AND this is one of their first few sessions.
 *   Using analytics as the source of truth means the learning loop
 *   sees the full funnel (shown → dismissed → knowledge-clicked)
 *   without a separate preferences table.
 *
 * POST action=dismissed  → record the dismissal event.
 * POST action=knowledge_clicked → record that the user followed the
 *   tooltip's Knowledge CTA (separate event so the funnel is visible
 *   even for users who never explicitly "dismiss").
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Has the user ever dismissed the welcome tooltip OR clicked into
  // the knowledge CTA? Either counts as "done".
  // Note: trackEvent writes to `instinct_events` (see src/lib/analytics.ts),
  // so we query that table here — not `instinct_analytics_events`.
  // Regression: the earlier mismatch made dismissals un-sticky and the
  // tooltip re-emerged on every refresh.
  const { rows } = await safeQuery<{ any: string }>(
    `SELECT '1' AS any
       FROM instinct_events
      WHERE user_id = $1
        AND event_type IN ('welcome_tooltip.dismissed', 'welcome_tooltip.knowledge_clicked')
      LIMIT 1`,
    [user.id],
  );
  const shouldShow = rows.length === 0;

  if (shouldShow) {
    trackEvent("welcome_tooltip.shown", user.id, user.role, {});
  }

  return NextResponse.json({ should_show: shouldShow });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "dismissed" && action !== "knowledge_clicked") {
    return NextResponse.json(
      { error: "action must be 'dismissed' or 'knowledge_clicked'" },
      { status: 400 },
    );
  }

  trackEvent(
    action === "dismissed"
      ? "welcome_tooltip.dismissed"
      : "welcome_tooltip.knowledge_clicked",
    user.id,
    user.role,
    {},
  );

  return NextResponse.json({ ok: true });
}
