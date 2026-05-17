/**
 * GET /api/admin/insights/unmet-intents
 *
 * Ranked backlog of phrases that fell through to the LLM (no
 * deterministic tool matched). The highest-leverage signal for "what
 * should we build next."
 *
 * Auth: cto / ceo / evp roles (matches the audit-log gate).
 *
 * Query params:
 *   since   hours, default 168 (7d), max 720 (30d)
 *   limit   default 50, max 500
 *   minLen  filter out phrases shorter than this. Default 6.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { getUnmetIntents } from "@/lib/insights/unmet-intents";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  /* Use ?? against parsed Number so explicit "0" doesn't fall back
   * to the default — minLength=0 means "no filter". */
  const parseNum = (key: string, fallback: number): number => {
    const raw = params.get(key);
    if (raw === null || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const sinceHours = clamp(parseNum("since", 168), 1, 720);
  const limit = clamp(parseNum("limit", 50), 1, 500);
  const minLength = clamp(parseNum("minLen", 6), 1, 200);

  const intents = await getUnmetIntents({ sinceHours, limit, minLength });
  trackEvent("system.audit_log_viewed", user.id, user.role, {
    view: "insights.unmet_intents",
    result_count: intents.length,
    since_hours: sinceHours,
  });

  return NextResponse.json({
    sinceHours,
    limit,
    minLength,
    count: intents.length,
    intents,
  });
}
