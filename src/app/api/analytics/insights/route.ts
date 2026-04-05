import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

/**
 * GET /api/analytics/insights — Compound analytics from learning views.
 *
 * Returns: automation_opportunities, team_expertise, question_to_doc_pipeline,
 * discussion_velocity, product_knowledge_demand.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  trackEvent("system.analytics_queried" as Parameters<typeof trackEvent>[0], user.id, user.role, {
    module: "compound_insights",
  });

  // Shadow mode — return demo data
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      shadow_mode: true,
      automation_opportunities: [
        {
          id: "demo-ao1",
          title: "Automated weekly client status emails",
          weekly_hours_saved: 2.5,
          yearly_hours_saved: 130,
          roi_ratio: 8.5,
          status: "submitted",
          votes: 3,
        },
        {
          id: "demo-ao2",
          title: "Auto-generate release notes from commits",
          weekly_hours_saved: 1.0,
          yearly_hours_saved: 52,
          roi_ratio: 12.0,
          status: "approved",
          votes: 5,
        },
      ],
      team_expertise: [
        {
          user_id: "demo-cto",
          user_role: "cto",
          expertise_tags: ["architecture", "security", "infrastructure"],
          questions_answered: 15,
          avg_answer_rating: 4.8,
          cache_hits_contributed: 8,
        },
        {
          user_id: "demo-dev",
          user_role: "dev",
          expertise_tags: ["react", "typescript", "api"],
          questions_answered: 22,
          avg_answer_rating: 4.5,
          cache_hits_contributed: 12,
        },
      ],
      question_to_doc_pipeline: [
        {
          question: "How does the auth flow work?",
          answer: "JWT-based with role hierarchy...",
          source: "docs",
          rating: 5,
          doc_title: "Authentication Architecture Guide",
          doc_type: "api_doc",
          downloads: 7,
        },
      ],
      discussion_velocity: [
        { category: "engineering", total_threads: 8, resolved: 6, avg_resolution_hours: 4.2 },
        { category: "product", total_threads: 5, resolved: 3, avg_resolution_hours: 12.5 },
        { category: "client", total_threads: 3, resolved: 3, avg_resolution_hours: 2.1 },
      ],
      product_knowledge_demand: [
        {
          product: "wolfpack-auto",
          total_questions: 18,
          answered_from_cache: 12,
          needed_ai: 6,
          high_quality: 14,
          needs_improvement: 4,
        },
        {
          product: "general",
          total_questions: 10,
          answered_from_cache: 7,
          needed_ai: 3,
          high_quality: 8,
          needs_improvement: 2,
        },
      ],
    });
  }

  // Live mode — query learning views
  const [
    automationOpps,
    teamExpertise,
    questionToDoc,
    discussionVelocity,
    productDemand,
  ] = await Promise.all([
    safeQuery("SELECT * FROM v_automation_opportunities LIMIT 20"),
    safeQuery("SELECT * FROM v_team_expertise LIMIT 50"),
    safeQuery("SELECT * FROM v_question_to_doc_pipeline LIMIT 20"),
    safeQuery("SELECT * FROM v_discussion_velocity"),
    safeQuery("SELECT * FROM v_product_knowledge_demand LIMIT 20"),
  ]);

  return NextResponse.json({
    shadow_mode: false,
    automation_opportunities: automationOpps.rows,
    team_expertise: teamExpertise.rows,
    question_to_doc_pipeline: questionToDoc.rows,
    discussion_velocity: discussionVelocity.rows,
    product_knowledge_demand: productDemand.rows,
  });
}
