import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent, getEventCounts, type InstinctEventType } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

// Valid values for instinct_setup_events columns (must match migration 016 CHECK constraints)
const VALID_SETUP_STEPS = new Set(["profile", "team", "integrations", "complete"]);
const VALID_INTEGRATIONS = new Set(["microsoft", "quickbooks", "plaud"]);

const SETUP_EVENT_MAP: Record<string, string> = {
  "system.setup_step_viewed": "setup_step_viewed",
  "system.setup_step_completed": "setup_step_completed",
  "system.setup_step_abandoned": "setup_step_abandoned",
  "system.setup_integration_connect_started": "setup_integration_connect_started",
  "system.setup_integration_connect_succeeded": "setup_integration_connect_succeeded",
  "system.setup_integration_connect_failed": "setup_integration_connect_failed",
};

async function writeSetupEvent(
  userId: string,
  event: string,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  const eventType = SETUP_EVENT_MAP[event];
  if (!eventType) return;

  const step = typeof metadata.step === "string" ? metadata.step : "";
  if (!VALID_SETUP_STEPS.has(step)) {
    console.warn("[analytics] setup event missing valid step, skipping structured write");
    return;
  }

  const integrationRaw = typeof metadata.integration === "string" ? metadata.integration : null;
  const integration = integrationRaw && VALID_INTEGRATIONS.has(integrationRaw) ? integrationRaw : null;
  const duration_ms = typeof metadata.duration_ms === "number" ? metadata.duration_ms : null;
  const attempt_number = typeof metadata.attempt_number === "number" ? metadata.attempt_number : 1;

  await safeQuery(
    `INSERT INTO instinct_setup_events
       (user_id, event_type, step, integration, duration_ms, attempt_number, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, eventType, step, integration, duration_ms, attempt_number, JSON.stringify(metadata)],
  );
}

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

    const meta = metadata || {};
    trackEvent(event as InstinctEventType, user.id, user.role, meta);

    if (event.startsWith("system.setup_") && event in SETUP_EVENT_MAP) {
      await writeSetupEvent(user.id, event, meta);
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to track event" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Plain-language activity labels
//
// Dev-jargon event names like "knowledge.question_asked" make the analytics
// page useless to non-technical team members. We bucket events into
// human-readable activity categories the team actually cares about.
// ---------------------------------------------------------------------------

interface ActivityBucket {
  label: string;
  description: string;
  count: number;
  events: string[];
}

function bucketEvents(eventCounts: Record<string, number>): ActivityBucket[] {
  const buckets: Record<string, ActivityBucket> = {
    questions: {
      label: "Questions asked",
      description: "Times the team asked the OGIAM Assistant a question",
      count: 0,
      events: ["knowledge.question_asked"],
    },
    cached_answers: {
      label: "Answers from memory",
      description: "Questions the Assistant answered without using AI",
      count: 0,
      events: ["system.ai_call_skipped"],
    },
    ai_answers: {
      label: "AI-generated answers",
      description: "Questions that needed an AI call to answer",
      count: 0,
      events: ["system.ai_call_made"],
    },
    docs_created: {
      label: "Documents generated",
      description: "Reports, proposals, and client docs created",
      count: 0,
      events: ["knowledge.doc_generated", "client.doc_generated", "client.proposal_created"],
    },
    meetings_ingested: {
      label: "Meetings ingested",
      description: "Plaud transcripts that landed in the team knowledge base",
      count: 0,
      events: ["plaud.transcript_ingested"],
    },
    discussions: {
      label: "Discussions",
      description: "Threads created, replies posted, or resolved",
      count: 0,
      events: ["discussion.thread_created", "discussion.reply_posted", "discussion.resolved"],
    },
    feature_requests: {
      label: "Feature requests",
      description: "Ideas submitted by the team",
      count: 0,
      events: ["feature.request_submitted"],
    },
    briefings: {
      label: "Morning briefings",
      description: "Daily briefings generated and viewed",
      count: 0,
      events: ["briefing.generated", "briefing.viewed"],
    },
  };

  for (const [eventName, count] of Object.entries(eventCounts)) {
    for (const bucket of Object.values(buckets)) {
      if (bucket.events.includes(eventName)) {
        bucket.count += count;
      }
    }
  }

  return Object.values(buckets).filter((b) => b.count > 0);
}

// ---------------------------------------------------------------------------
// AI efficiency — compute real values from instinct_events.
// ---------------------------------------------------------------------------

interface AiEfficiency {
  zero_token_pct: number;
  zero_token_answers: number;
  ai_calls: number;
  trend: number[]; // last 7 days, % zero-token per day
  meeting_savings: number; // count of answers served from meeting transcripts
  knowledge_savings: number; // count of answers served from knowledge cache
}

async function computeAiEfficiency(): Promise<AiEfficiency | null> {
  if (!process.env.DATABASE_URL) return null;

  // Last 7 days totals
  const totals = await safeQuery<{ skipped: number; made: number; meeting: number; cache: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE event_type = 'system.ai_call_skipped')::int                                AS skipped,
       COUNT(*) FILTER (WHERE event_type = 'system.ai_call_made')::int                                   AS made,
       COUNT(*) FILTER (WHERE event_type = 'system.ai_call_skipped' AND metadata->>'reason' = 'meeting_transcripts_hit')::int AS meeting,
       COUNT(*) FILTER (WHERE event_type = 'system.ai_call_skipped' AND metadata->>'reason' = 'knowledge_cache_hit')::int     AS cache
     FROM instinct_events
     WHERE timestamp > NOW() - INTERVAL '7 days'`,
  );

  if (totals.fromCache || totals.rows.length === 0) return null;
  const row = totals.rows[0];
  const total = row.skipped + row.made;
  if (total === 0) return null;

  // Per-day trend over last 7 days
  const trendRows = await safeQuery<{ day: string; skipped: number; made: number }>(
    `SELECT
       date_trunc('day', timestamp) AS day,
       COUNT(*) FILTER (WHERE event_type = 'system.ai_call_skipped')::int AS skipped,
       COUNT(*) FILTER (WHERE event_type = 'system.ai_call_made')::int    AS made
     FROM instinct_events
     WHERE timestamp > NOW() - INTERVAL '7 days'
       AND event_type IN ('system.ai_call_skipped', 'system.ai_call_made')
     GROUP BY 1
     ORDER BY 1 ASC`,
  );

  const trend: number[] = [];
  for (const r of trendRows.rows) {
    const dayTotal = r.skipped + r.made;
    trend.push(dayTotal === 0 ? 0 : Math.round((r.skipped / dayTotal) * 100));
  }
  // Pad to 7 entries if we have fewer days of data
  while (trend.length < 7) trend.unshift(0);

  return {
    zero_token_pct: Math.round((row.skipped / total) * 1000) / 10,
    zero_token_answers: row.skipped,
    ai_calls: row.made,
    trend: trend.slice(-7),
    meeting_savings: row.meeting,
    knowledge_savings: row.cache,
  };
}

// ---------------------------------------------------------------------------
// Doc quality gate activity (last 7 days) — surfaces what's been
// blocked / warned / passed so the team can see why the Assistant
// silently rejected something.
// ---------------------------------------------------------------------------

interface GateActivity {
  total_checked: number;
  passed: number;
  warned: number;
  rejected: number;
  recent_rejections: Array<{
    file_name: string;
    reasons: string;
    when: string;
  }>;
}

async function fetchGateActivity(): Promise<GateActivity | null> {
  if (!process.env.DATABASE_URL) return null;

  const summary = await safeQuery<{ verdict: string; n: number }>(
    `SELECT metadata->>'verdict' AS verdict, COUNT(*)::int AS n
     FROM instinct_events
     WHERE event_type = 'assistant.doc_quality_checked'
       AND timestamp > NOW() - INTERVAL '7 days'
     GROUP BY 1`,
  );

  if (summary.fromCache) return null;

  const counts: Record<string, number> = { pass: 0, warn: 0, reject: 0 };
  for (const r of summary.rows) {
    if (r.verdict && counts[r.verdict] !== undefined) counts[r.verdict] = r.n;
  }
  const total = counts.pass + counts.warn + counts.reject;

  const recentRejections = await safeQuery<{ file_name: string; reasons: string; ts: string }>(
    `SELECT
       metadata->>'file_name' AS file_name,
       metadata->>'reasons'   AS reasons,
       timestamp::text        AS ts
     FROM instinct_events
     WHERE event_type = 'assistant.doc_rejected'
       AND timestamp > NOW() - INTERVAL '7 days'
     ORDER BY timestamp DESC
     LIMIT 10`,
  );

  return {
    total_checked: total,
    passed: counts.pass,
    warned: counts.warn,
    rejected: counts.reject,
    recent_rejections: recentRejections.rows.map((r) => ({
      file_name: r.file_name || "(unknown)",
      reasons: r.reasons || "no reason recorded",
      when: r.ts,
    })),
  };
}

// ---------------------------------------------------------------------------
// Integration health — which integrations have actually delivered
// data in the last 7 days. Live status, not configuration status.
// ---------------------------------------------------------------------------

interface IntegrationHealth {
  name: string;
  label: string;
  status: "active" | "configured" | "inactive";
  last_event_at: string | null;
  events_7d: number;
}

async function fetchIntegrationHealth(): Promise<IntegrationHealth[]> {
  if (!process.env.DATABASE_URL) return [];

  const integrations = [
    { name: "microsoft", label: "Microsoft 365", prefix: "microsoft." },
    { name: "quickbooks", label: "QuickBooks", prefix: "quickbooks." },
    { name: "plaud", label: "Plaud (meetings)", prefix: "plaud." },
  ];

  const out: IntegrationHealth[] = [];
  for (const i of integrations) {
    const r = await safeQuery<{ events_7d: number; last_event_at: string | null }>(
      `SELECT
         COUNT(*)::int                AS events_7d,
         MAX(timestamp)::text         AS last_event_at
       FROM instinct_events
       WHERE event_type LIKE $1
         AND timestamp > NOW() - INTERVAL '7 days'`,
      [`${i.prefix}%`],
    );
    if (r.fromCache) continue;
    const row = r.rows[0] || { events_7d: 0, last_event_at: null };
    out.push({
      name: i.name,
      label: i.label,
      status: row.events_7d > 0 ? "active" : "inactive",
      last_event_at: row.last_event_at,
      events_7d: row.events_7d,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Meeting ingestion stats (per the apex_v_meeting_ingestion_quality view)
// ---------------------------------------------------------------------------

interface MeetingStats {
  total_transcripts: number;
  passed: number;
  warned: number;
  rejected: number;
  per_owner: Array<{ owner_user_id: string; total: number; passed: number; warned: number; rejected: number }>;
  last_ingest_at: string | null;
}

async function fetchMeetingStats(): Promise<MeetingStats | null> {
  if (!process.env.DATABASE_URL) return null;

  const summary = await safeQuery<{
    owner_user_id: string;
    total_transcripts: number;
    passed: number;
    warned: number;
    rejected: number;
    last_ingest_at: string | null;
  }>(
    `SELECT owner_user_id, total_transcripts, passed, warned, rejected, last_ingest_at::text
     FROM apex_v_meeting_ingestion_quality`,
  );

  if (summary.fromCache) return null;
  if (summary.rows.length === 0) {
    return { total_transcripts: 0, passed: 0, warned: 0, rejected: 0, per_owner: [], last_ingest_at: null };
  }

  const totals = summary.rows.reduce(
    (acc, r) => ({
      total: acc.total + r.total_transcripts,
      passed: acc.passed + r.passed,
      warned: acc.warned + r.warned,
      rejected: acc.rejected + r.rejected,
      last: r.last_ingest_at && (!acc.last || r.last_ingest_at > acc.last) ? r.last_ingest_at : acc.last,
    }),
    { total: 0, passed: 0, warned: 0, rejected: 0, last: null as string | null },
  );

  return {
    total_transcripts: totals.total,
    passed: totals.passed,
    warned: totals.warned,
    rejected: totals.rejected,
    per_owner: summary.rows.map((r) => ({
      owner_user_id: r.owner_user_id,
      total: r.total_transcripts,
      passed: r.passed,
      warned: r.warned,
      rejected: r.rejected,
    })),
    last_ingest_at: totals.last,
  };
}

/**
 * GET /api/analytics — Return analytics data for the dashboard.
 *
 * Returns real data only. When the system is connected to a real DB
 * but has no data yet (fresh install), returns empty arrays + a
 * `live_mode_empty: true` flag so the UI can show actionable empty
 * states instead of fake numbers.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  trackEvent("system.page_viewed", user.id, user.role, {
    page: "analytics",
    module: "analytics",
  });

  const eventCounts = await getEventCounts(168); // last 7 days

  const [
    topQuestions,
    featurePipeline,
    teamActivity,
    docStats,
    searchTerms,
    aiEfficiency,
    gateActivity,
    integrationHealth,
    meetingStats,
  ] = await Promise.all([
    safeQuery<{ question: string; view_count: number }>(
      "SELECT question, view_count FROM instinct_knowledge ORDER BY view_count DESC LIMIT 10",
    ),
    safeQuery<{ status: string; count: number }>(
      "SELECT status, COUNT(*)::int AS count FROM instinct_feature_requests GROUP BY status ORDER BY count DESC",
    ),
    safeQuery<{ user_id: string; user_name: string | null; event_count: number }>(
      `SELECT e.user_id,
              m.name AS user_name,
              COUNT(*)::int AS event_count
       FROM instinct_events e
       LEFT JOIN instinct_team_members m ON m.id = e.user_id
       WHERE e.timestamp > NOW() - INTERVAL '7 days'
         AND e.user_id NOT IN ('system')
       GROUP BY e.user_id, m.name
       ORDER BY event_count DESC
       LIMIT 10`,
    ),
    safeQuery<{ doc_type: string; count: number; total_downloads: number }>(
      `SELECT doc_type, COUNT(*)::int AS count, COALESCE(SUM(downloads), 0)::int AS total_downloads
       FROM instinct_documents
       GROUP BY doc_type`,
    ),
    safeQuery<{ term: string; count: number }>(
      `SELECT metadata->>'module' AS term, COUNT(*)::int AS count
       FROM instinct_events
       WHERE event_type = 'system.search_performed'
         AND timestamp > NOW() - INTERVAL '7 days'
       GROUP BY metadata->>'module'
       ORDER BY count DESC
       LIMIT 10`,
    ),
    computeAiEfficiency(),
    fetchGateActivity(),
    fetchIntegrationHealth(),
    fetchMeetingStats(),
  ]);

  // If the database isn't reachable at all, signal explicitly. The UI
  // shows a "database unreachable" message rather than fake demo data.
  if (topQuestions.fromCache) {
    return NextResponse.json({
      shadow_mode: false,
      live_mode_empty: false,
      database_unreachable: true,
      activity_summary: [],
      event_counts: {},
      top_questions: [],
      feature_pipeline: [],
      team_activity: [],
      doc_stats: [],
      search_terms: [],
      ai_efficiency: null,
      gate_activity: null,
      integration_health: [],
      meeting_stats: null,
    });
  }

  const activitySummary = bucketEvents(eventCounts);
  const totalEvents = Object.values(eventCounts).reduce((a, b) => a + b, 0);
  const liveModeEmpty = totalEvents === 0;

  return NextResponse.json({
    shadow_mode: false,
    live_mode_empty: liveModeEmpty,
    database_unreachable: false,
    activity_summary: activitySummary,
    event_counts: eventCounts,
    top_questions: topQuestions.rows,
    feature_pipeline: featurePipeline.rows,
    team_activity: teamActivity.rows,
    doc_stats: docStats.rows,
    search_terms: searchTerms.rows,
    ai_efficiency: aiEfficiency,
    gate_activity: gateActivity,
    integration_health: integrationHealth,
    meeting_stats: meetingStats,
  });
}
