import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [knowledge, discussions, features, efficiency] = await Promise.all([
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM instinct_knowledge"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM instinct_discussions WHERE status = 'open'"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM instinct_feature_requests"),
    safeQuery<{ zero_token_pct: number; zero_token_answers: number; ai_calls: number }>(
      "SELECT * FROM v_ai_efficiency LIMIT 1"
    ),
  ]);

  const isShadow = knowledge.fromCache;

  trackEvent("system.page_viewed", "anonymous", "unknown", { page: "dashboard_api" });

  if (isShadow) {
    return NextResponse.json({
      shadow_mode: true,
      knowledge_count: 47,
      discussion_count: 12,
      feature_count: 8,
      team_count: 4,
      ai_efficiency: { zero_token_pct: 73.2, zero_token_answers: 34, ai_calls: 12 },
    });
  }

  return NextResponse.json({
    shadow_mode: false,
    knowledge_count: knowledge.rows[0]?.count ?? 0,
    discussion_count: discussions.rows[0]?.count ?? 0,
    feature_count: features.rows[0]?.count ?? 0,
    team_count: 7,
    ai_efficiency: efficiency.rows[0] || null,
  });
}
