"use client";

import { useState, useEffect } from "react";

interface DashboardData {
  shadow_mode: boolean;
  knowledge_count: number;
  discussion_count: number;
  feature_count: number;
  team_count: number;
  ai_efficiency: { zero_token_pct: number; zero_token_answers: number; ai_calls: number } | null;
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

const EVENT_LABELS: Record<string, string> = {
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

interface RecentEvent {
  id: string;
  event_type: string;
  user_id: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardData | null>(null);
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("apex_token");
    if (!token) return;

    // Track page view
    fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "dashboard" } }),
    }).catch(() => {});

    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Fetch recent events from journal
    fetch("/api/journal", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.journal?.auto_context?.events) {
          setEvents(data.journal.auto_context.events);
        }
      })
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading dashboard...</p>
      </div>
    );
  }

  const statCards = [
    { label: "Knowledge Entries", value: stats?.knowledge_count ?? 0, color: "var(--wp-gold)" },
    { label: "Active Discussions", value: stats?.discussion_count ?? 0, color: "var(--wp-info)" },
    { label: "Feature Requests", value: stats?.feature_count ?? 0, color: "var(--wp-success)" },
    { label: "Team Members", value: stats?.team_count ?? 0, color: "var(--wp-warning)" },
  ];

  const quickActions = [
    { label: "Ask a Question", href: "/knowledge" },
    { label: "Create Discussion", href: "/discussions" },
    { label: "Submit Feature", href: "/features" },
    { label: "View Journal", href: "/journal" },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
        Dashboard
      </h1>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg p-5 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <p className="text-3xl font-bold" style={{ color: card.color }}>
              {card.value}
            </p>
            <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
              {card.label}
            </p>
          </div>
        ))}
      </div>

      {/* AI Efficiency */}
      {stats?.ai_efficiency && (
        <div
          className="rounded-lg p-5 border"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
            AI Efficiency
          </h2>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="flex justify-between text-sm mb-1">
                <span style={{ color: "var(--wp-text-dim)" }}>Zero-Token Rate</span>
                <span style={{ color: "var(--wp-gold)" }}>{stats.ai_efficiency.zero_token_pct}%</span>
              </div>
              <div className="h-3 rounded-full overflow-hidden" style={{ background: "var(--wp-dark-surface2)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(stats.ai_efficiency.zero_token_pct, 100)}%`,
                    background:
                      stats.ai_efficiency.zero_token_pct >= 70
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
            {events.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                No activity yet. Start by asking a question or creating a discussion.
              </p>
            ) : (
              events.slice(0, 8).map((event) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between py-2 border-b last:border-b-0 gap-3"
                  style={{ borderColor: "var(--wp-dark-border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {EVENT_LABELS[event.event_type] || event.event_type.replace(/[._]/g, " ")}
                    </p>
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
    </div>
  );
}
