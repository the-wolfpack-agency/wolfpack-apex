import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent, getEventCounts, type ApexEventType } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

/**
 * POST /api/analytics — Track a page view or event from the client.
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { event, metadata } = body as {
      event?: string;
      metadata?: Record<string, string | number | boolean>;
    };

    if (!event) {
      return NextResponse.json({ error: "event is required" }, { status: 400 });
    }

    trackEvent(event as ApexEventType, user.id, user.role, metadata || {});
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to track event" }, { status: 500 });
  }
}

/**
 * GET /api/analytics — Return analytics data for the dashboard.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventCounts = await getEventCounts(168); // last 7 days

  // Fetch additional metrics
  const [
    topQuestions,
    featurePipeline,
    teamActivity,
    docStats,
    searchTerms,
  ] = await Promise.all([
    safeQuery<{ question: string; view_count: number }>(
      "SELECT question, view_count FROM apex_knowledge ORDER BY view_count DESC LIMIT 10"
    ),
    safeQuery<{ status: string; count: number }>(
      "SELECT status, COUNT(*)::int AS count FROM apex_feature_requests GROUP BY status ORDER BY count DESC"
    ),
    safeQuery<{ user_id: string; event_count: number }>(
      `SELECT user_id, COUNT(*)::int AS event_count
       FROM apex_events
       WHERE timestamp > NOW() - INTERVAL '7 days'
       GROUP BY user_id
       ORDER BY event_count DESC
       LIMIT 10`
    ),
    safeQuery<{ doc_type: string; count: number; total_downloads: number }>(
      `SELECT doc_type, COUNT(*)::int AS count, COALESCE(SUM(downloads), 0)::int AS total_downloads
       FROM apex_documents
       GROUP BY doc_type`
    ),
    safeQuery<{ term: string; count: number }>(
      `SELECT metadata->>'module' AS term, COUNT(*)::int AS count
       FROM apex_events
       WHERE event_type = 'system.search_performed'
         AND timestamp > NOW() - INTERVAL '7 days'
       GROUP BY metadata->>'module'
       ORDER BY count DESC
       LIMIT 10`
    ),
  ]);

  const isShadow = topQuestions.fromCache;

  if (isShadow) {
    return NextResponse.json({
      shadow_mode: true,
      event_counts: {
        "knowledge.question_asked": 34,
        "knowledge.answer_found": 28,
        "knowledge.answer_not_found": 6,
        "feature.request_submitted": 8,
        "discussion.thread_created": 5,
        "system.login": 18,
        "system.search_performed": 42,
        "knowledge.doc_generated": 7,
      },
      top_questions: [
        { question: "How does the auth flow work?", view_count: 12 },
        { question: "What database does Apex use?", view_count: 8 },
        { question: "How do I deploy to production?", view_count: 6 },
        { question: "What is the pricing model?", view_count: 5 },
        { question: "How does SSO integration work?", view_count: 4 },
      ],
      feature_pipeline: [
        { status: "submitted", count: 4 },
        { status: "analyzing", count: 2 },
        { status: "approved", count: 1 },
        { status: "in_progress", count: 1 },
        { status: "completed", count: 3 },
      ],
      team_activity: [
        { user_id: "demo-cto", event_count: 45 },
        { user_id: "demo-dev", event_count: 32 },
        { user_id: "demo-ops", event_count: 18 },
        { user_id: "demo-sales", event_count: 12 },
      ],
      doc_stats: [
        { doc_type: "api_doc", count: 4, total_downloads: 12 },
        { doc_type: "feature_doc", count: 2, total_downloads: 5 },
        { doc_type: "release_notes", count: 1, total_downloads: 3 },
      ],
      search_terms: [
        { term: "knowledge", count: 18 },
        { term: "features", count: 12 },
        { term: "docs", count: 8 },
      ],
      ai_efficiency: {
        zero_token_pct: 73.2,
        zero_token_answers: 34,
        ai_calls: 12,
        trend: [65, 68, 70, 71, 73, 73, 73],
      },
      automation_suggestions: [
        {
          title: "Weekly client status emails",
          frequency: "5x/week",
          duration_minutes: 15,
          time_saved_yearly: 3900,
          category: "automation",
        },
        {
          title: "Monthly report generation",
          frequency: "4x/month",
          duration_minutes: 45,
          time_saved_yearly: 2160,
          category: "automation",
        },
      ],
    });
  }

  return NextResponse.json({
    shadow_mode: false,
    event_counts: eventCounts,
    top_questions: topQuestions.rows,
    feature_pipeline: featurePipeline.rows,
    team_activity: teamActivity.rows,
    doc_stats: docStats.rows,
    search_terms: searchTerms.rows,
    ai_efficiency: null,
    automation_suggestions: [],
  });
}
