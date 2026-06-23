import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { generateBriefing } from "@/lib/morning-briefing";

/**
 * GET /api/briefing
 *
 * Returns a personalized morning briefing for any authenticated user.
 * Content adapts based on the user's role and connected integrations.
 *
 * Query params:
 *   ?refresh=true — Force regenerate (bypass 30-minute cache)
 *   ?tz=<IANA>:    The user's browser timezone (e.g. America/New_York).
 *                   Used to compute the local-day calendar window so the
 *                   schedule does not combine two local days. Falls back to
 *                   the Eastern default inside generateBriefing when absent.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "true";

  // Loose validation: a non-empty, length-bounded string. The timezone helper
  // resolves Windows/IANA names and falls back safely on anything unrecognized,
  // so we only guard against absurd input here, not exact zone correctness.
  const rawTz = url.searchParams.get("tz");
  const timeZone =
    rawTz && rawTz.length > 0 && rawTz.length <= 64 ? rawTz : undefined;

  trackEvent("briefing.viewed", user.id, user.role, { refresh: forceRefresh });

  if (forceRefresh) {
    trackEvent("briefing.refreshed", user.id, user.role, {});
  }

  const briefing = await generateBriefing(user.id, user.role, {
    force: forceRefresh,
    userName: user.name.split(" ")[0],
    timeZone,
  });

  return NextResponse.json(briefing);
}
