"use client";

import { useState, useEffect } from "react";

interface AnalyticsData {
  shadow_mode: boolean;
  event_counts: Record<string, number>;
  top_questions: Array<{ question: string; view_count: number }>;
  feature_pipeline: Array<{ status: string; count: number }>;
  team_activity: Array<{ user_id: string; event_count: number }>;
  doc_stats: Array<{ doc_type: string; count: number; total_downloads: number }>;
  search_terms: Array<{ term: string; count: number }>;
  ai_efficiency: {
    zero_token_pct: number;
    zero_token_answers: number;
    ai_calls: number;
    trend: number[];
  } | null;
  automation_suggestions: Array<{
    title: string;
    frequency: string;
    duration_minutes: number;
    time_saved_yearly: number;
    category: string;
  }>;
}

const STATUS_COLORS: Record<string, string> = {
  submitted: "var(--wp-info)",
  analyzing: "var(--wp-warning)",
  approved: "var(--wp-success)",
  in_progress: "var(--wp-gold)",
  completed: "var(--wp-success)",
};

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  function authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    };
  }

  useEffect(() => {
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "analytics" } }),
    }).catch(() => {});

    fetch("/api/analytics", { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading analytics...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-5xl mx-auto">
        <p style={{ color: "var(--wp-text-muted)" }}>Failed to load analytics data.</p>
      </div>
    );
  }

  const totalEvents = Object.values(data.event_counts).reduce((a, b) => a + b, 0);

  // Build trend bars for AI efficiency
  const trendValues = data.ai_efficiency?.trend || [];
  const trendMax = Math.max(...trendValues, 1);

  // Feature pipeline total
  const pipelineTotal = data.feature_pipeline.reduce((a, b) => a + b.count, 0);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
        Analytics
      </h1>

      {/* Top stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Events (7d)" value={totalEvents} color="var(--wp-gold)" />
        <StatCard
          label="Zero-Token Rate"
          value={data.ai_efficiency ? `${data.ai_efficiency.zero_token_pct}%` : "N/A"}
          color="var(--wp-success)"
        />
        <StatCard
          label="Questions Asked"
          value={data.event_counts["knowledge.question_asked"] || 0}
          color="var(--wp-info)"
        />
        <StatCard
          label="Docs Generated"
          value={data.event_counts["knowledge.doc_generated"] || 0}
          color="var(--wp-warning)"
        />
      </div>

      {/* AI Efficiency Trend */}
      {data.ai_efficiency && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            AI Efficiency Trend
          </h2>
          <div className="flex items-end gap-2 h-32">
            {trendValues.map((v, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  {v}%
                </span>
                <div
                  className="w-full rounded-t"
                  style={{
                    height: `${(v / trendMax) * 100}%`,
                    background: v >= 70 ? "var(--wp-success)" : v >= 40 ? "var(--wp-warning)" : "var(--wp-error)",
                    minHeight: "4px",
                  }}
                />
                <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                  D{i + 1}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs" style={{ color: "var(--wp-text-dim)" }}>
            <span>
              <span style={{ color: "var(--wp-success)" }}>{data.ai_efficiency.zero_token_answers}</span> cached answers
            </span>
            <span>
              <span style={{ color: "var(--wp-warning)" }}>{data.ai_efficiency.ai_calls}</span> AI calls
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Most Asked Questions */}
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Most Asked Questions
          </h2>
          {data.top_questions.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>No questions yet.</p>
          ) : (
            <div className="space-y-3">
              {data.top_questions.map((q, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <p className="text-sm flex-1 min-w-0 truncate">{q.question}</p>
                  <span
                    className="text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap"
                    style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-gold)" }}
                  >
                    {q.view_count} views
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Team Activity */}
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Team Activity (7d)
          </h2>
          {data.team_activity.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>No activity.</p>
          ) : (
            <div className="space-y-3">
              {data.team_activity.map((member, i) => {
                const maxEvents = data.team_activity[0]?.event_count || 1;
                return (
                  <div key={i}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span>{member.user_id}</span>
                      <span style={{ color: "var(--wp-text-dim)" }}>{member.event_count} events</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--wp-dark-surface2)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(member.event_count / maxEvents) * 100}%`,
                          background: "var(--wp-gold)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Feature Pipeline */}
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Feature Request Pipeline
          </h2>
          {data.feature_pipeline.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>No features.</p>
          ) : (
            <div className="space-y-3">
              {data.feature_pipeline.map((stage, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="capitalize">{stage.status.replace(/_/g, " ")}</span>
                    <span style={{ color: "var(--wp-text-dim)" }}>{stage.count}</span>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--wp-dark-surface2)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: pipelineTotal > 0 ? `${(stage.count / pipelineTotal) * 100}%` : "0%",
                        background: STATUS_COLORS[stage.status] || "var(--wp-text-dim)",
                        minWidth: stage.count > 0 ? "8px" : "0",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Document Stats */}
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Document Generation
          </h2>
          {data.doc_stats.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>No documents generated yet.</p>
          ) : (
            <div className="space-y-3">
              {data.doc_stats.map((stat, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{ background: "var(--wp-dark-surface2)" }}
                >
                  <span className="text-sm font-medium capitalize">
                    {stat.doc_type.replace(/_/g, " ")}
                  </span>
                  <div className="flex items-center gap-4 text-xs" style={{ color: "var(--wp-text-dim)" }}>
                    <span>{stat.count} docs</span>
                    <span>{stat.total_downloads} downloads</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Popular Search Terms */}
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Popular Search Terms
          </h2>
          {data.search_terms.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>No searches yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.search_terms.map((term, i) => (
                <span
                  key={i}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    color: "var(--wp-text-dim)",
                    border: "1px solid var(--wp-dark-border)",
                  }}
                >
                  {term.term}{" "}
                  <span style={{ color: "var(--wp-gold)" }}>({term.count})</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Automation Potential */}
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Automation Potential
          </h2>
          {data.automation_suggestions.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              No automation suggestions yet. Team members can submit manual tasks on the Features page.
            </p>
          ) : (
            <div className="space-y-3">
              {data.automation_suggestions.map((s, i) => (
                <div
                  key={i}
                  className="p-3 rounded-lg"
                  style={{ background: "var(--wp-dark-surface2)" }}
                >
                  <p className="text-sm font-medium">{s.title}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs" style={{ color: "var(--wp-text-dim)" }}>
                    <span>{s.frequency}</span>
                    <span>{s.duration_minutes}min each</span>
                    <span style={{ color: "var(--wp-success)" }}>
                      ~{Math.round(s.time_saved_yearly / 60)}h/yr saved
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div
      className="rounded-lg p-5 border"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <p className="text-3xl font-bold" style={{ color }}>
        {value}
      </p>
      <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
        {label}
      </p>
    </div>
  );
}
