import { safeQuery } from "@/lib/db";

interface DashboardStats {
  knowledge_count: number;
  discussion_count: number;
  feature_count: number;
  team_count: number;
  recent_events: Array<{
    id: string;
    event_type: string;
    user_id: string;
    metadata: Record<string, unknown>;
    timestamp: string;
  }>;
  ai_efficiency: { zero_token_pct: number; zero_token_answers: number; ai_calls: number } | null;
}

async function getDashboardStats(): Promise<DashboardStats> {
  const [knowledge, discussions, features, team, events, efficiency] = await Promise.all([
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM apex_knowledge"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM apex_discussions WHERE status = 'open'"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM apex_feature_requests"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM apex_team_members WHERE is_active = true"),
    safeQuery<{ id: string; event_type: string; user_id: string; metadata: Record<string, unknown>; timestamp: string }>(
      "SELECT id::text, event_type, user_id, metadata, timestamp FROM apex_events ORDER BY timestamp DESC LIMIT 10"
    ),
    safeQuery<{ zero_token_pct: number; zero_token_answers: number; ai_calls: number }>(
      "SELECT * FROM v_ai_efficiency LIMIT 1"
    ),
  ]);

  const isShadow = knowledge.fromCache;

  if (isShadow) {
    return {
      knowledge_count: 47,
      discussion_count: 12,
      feature_count: 8,
      team_count: 4,
      recent_events: [
        { id: "1", event_type: "knowledge.question_asked", user_id: "demo-cto", metadata: { question: "How does the auth flow work?" }, timestamp: new Date(Date.now() - 300_000).toISOString() },
        { id: "2", event_type: "feature.request_submitted", user_id: "demo-dev", metadata: { title: "Add dark mode toggle" }, timestamp: new Date(Date.now() - 600_000).toISOString() },
        { id: "3", event_type: "discussion.thread_created", user_id: "demo-ops", metadata: { title: "Q2 planning" }, timestamp: new Date(Date.now() - 900_000).toISOString() },
        { id: "4", event_type: "journal.entry_created", user_id: "demo-cto", metadata: { mood: "productive" }, timestamp: new Date(Date.now() - 1_200_000).toISOString() },
        { id: "5", event_type: "knowledge.answer_found", user_id: "demo-dev", metadata: { source: "codebase" }, timestamp: new Date(Date.now() - 1_500_000).toISOString() },
      ],
      ai_efficiency: { zero_token_pct: 73.2, zero_token_answers: 34, ai_calls: 12 },
    };
  }

  return {
    knowledge_count: knowledge.rows[0]?.count ?? 0,
    discussion_count: discussions.rows[0]?.count ?? 0,
    feature_count: features.rows[0]?.count ?? 0,
    team_count: team.rows[0]?.count ?? 0,
    recent_events: events.rows,
    ai_efficiency: efficiency.rows[0] || null,
  };
}

function formatEventType(type: string): string {
  const labels: Record<string, string> = {
    "knowledge.question_asked": "Asked a question",
    "knowledge.answer_found": "Found an answer",
    "knowledge.answer_not_found": "No answer found",
    "knowledge.answer_rated": "Rated an answer",
    "knowledge.doc_generated": "Generated a document",
    "feature.request_submitted": "Submitted feature request",
    "feature.request_analyzed": "Feature analyzed",
    "feature.request_approved": "Feature approved",
    "discussion.thread_created": "Created discussion",
    "discussion.reply_posted": "Replied to discussion",
    "discussion.resolved": "Resolved discussion",
    "journal.entry_created": "Wrote journal entry",
    "system.login": "Logged in",
  };
  return labels[type] || type.replace(/[._]/g, " ");
}

function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function Home() {
  const stats = await getDashboardStats();

  const statCards = [
    { label: "Knowledge Entries", value: stats.knowledge_count, icon: "\uD83D\uDCDA" },
    { label: "Active Discussions", value: stats.discussion_count, icon: "\uD83D\uDCAC" },
    { label: "Feature Requests", value: stats.feature_count, icon: "\uD83D\uDCA1" },
    { label: "Team Members", value: stats.team_count, icon: "\uD83D\uDC65" },
  ];

  const quickActions = [
    { label: "Ask a Question", href: "/knowledge/ask", icon: "\u2753" },
    { label: "Create Discussion", href: "/discussions/new", icon: "\uD83D\uDDE3\uFE0F" },
    { label: "Submit Feature Request", href: "/features/new", icon: "\uD83D\uDE80" },
    { label: "Write Journal", href: "/journal/new", icon: "\uD83D\uDCD3" },
  ];

  return (
    <div className="min-h-screen" style={{ background: "var(--wp-dark)" }}>
      {/* Header */}
      <header className="border-b px-6 py-4 flex items-center justify-between" style={{ borderColor: "var(--wp-dark-border)" }}>
        <div className="flex items-center gap-3">
          <span className="text-3xl">{"\uD83D\uDC3A"}</span>
          <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)", fontFamily: "'Lexend Peta', sans-serif" }}>
            Wolfpack Apex
          </h1>
        </div>
        <span className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          Team Intelligence Platform
        </span>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Stat Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((card) => (
            <div
              key={card.label}
              className="rounded-lg p-5 border"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-2xl">{card.icon}</span>
                <span className="text-3xl font-bold" style={{ color: "var(--wp-gold)" }}>
                  {card.value}
                </span>
              </div>
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>{card.label}</p>
            </div>
          ))}
        </div>

        {/* AI Efficiency Meter */}
        {stats.ai_efficiency && (
          <div
            className="rounded-lg p-5 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
              AI Efficiency
            </h2>
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <div className="flex justify-between text-sm mb-1">
                  <span style={{ color: "var(--wp-text-dim)" }}>Zero-Token Rate</span>
                  <span style={{ color: "var(--wp-gold)" }}>{stats.ai_efficiency.zero_token_pct}%</span>
                </div>
                <div className="h-3 rounded-full overflow-hidden" style={{ background: "var(--wp-dark-surface2)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(stats.ai_efficiency.zero_token_pct, 100)}%`,
                      background: stats.ai_efficiency.zero_token_pct >= 70
                        ? "var(--wp-success)"
                        : stats.ai_efficiency.zero_token_pct >= 40
                          ? "var(--wp-warning)"
                          : "var(--wp-error)",
                    }}
                  />
                </div>
              </div>
              <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                <span style={{ color: "var(--wp-success)" }}>{stats.ai_efficiency.zero_token_answers}</span> cached
                {" / "}
                <span style={{ color: "var(--wp-warning)" }}>{stats.ai_efficiency.ai_calls}</span> AI calls
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Quick Actions */}
          <div
            className="rounded-lg p-5 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
              Quick Actions
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {quickActions.map((action) => (
                <a
                  key={action.label}
                  href={action.href}
                  className="flex items-center gap-2 rounded-lg p-3 border transition-colors hover:border-[var(--wp-gold)]"
                  style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
                >
                  <span className="text-lg">{action.icon}</span>
                  <span className="text-sm font-medium">{action.label}</span>
                </a>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <div
            className="rounded-lg p-5 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
              Recent Activity
            </h2>
            <div className="space-y-3">
              {stats.recent_events.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                  No activity yet. Start by asking a question or creating a discussion.
                </p>
              ) : (
                stats.recent_events.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between py-2 border-b last:border-b-0"
                    style={{ borderColor: "var(--wp-dark-border)" }}
                  >
                    <div>
                      <p className="text-sm font-medium">{formatEventType(event.event_type)}</p>
                      <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                        {event.user_id}
                      </p>
                    </div>
                    <span className="text-xs whitespace-nowrap" style={{ color: "var(--wp-text-dim)" }}>
                      {formatTimeAgo(event.timestamp)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
