"use client";

import { useState, useEffect } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface ActivityBucket {
  label: string;
  description: string;
  count: number;
  events: string[];
}

interface AnalyticsData {
  shadow_mode: boolean;
  live_mode_empty: boolean;
  database_unreachable: boolean;
  activity_summary: ActivityBucket[];
  event_counts: Record<string, number>;
  top_questions: Array<{ question: string; view_count: number }>;
  feature_pipeline: Array<{ status: string; count: number }>;
  team_activity: Array<{ user_id: string; user_name?: string | null; event_count: number }>;
  doc_stats: Array<{ doc_type: string; count: number; total_downloads: number }>;
  search_terms: Array<{ term: string; count: number }>;
  ai_efficiency: {
    zero_token_pct: number;
    zero_token_answers: number;
    ai_calls: number;
    trend: number[];
    meeting_savings: number;
    knowledge_savings: number;
  } | null;
  gate_activity: {
    total_checked: number;
    passed: number;
    warned: number;
    rejected: number;
    recent_rejections: Array<{ file_name: string; reasons: string; when: string }>;
  } | null;
  integration_health: Array<{
    name: string;
    label: string;
    status: "active" | "configured" | "inactive";
    last_event_at: string | null;
    events_7d: number;
  }>;
  meeting_stats: {
    total_transcripts: number;
    passed: number;
    warned: number;
    rejected: number;
    per_owner: Array<{ owner_user_id: string; total: number; passed: number; warned: number; rejected: number }>;
    last_ingest_at: string | null;
  } | null;
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

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "analytics" } }),
    }).catch(() => {});

    fetchWithRefresh("/api/analytics", { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
     
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

  if (data.database_unreachable) {
    return (
      <div className="max-w-5xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Analytics</h1>
        <div
          className="rounded-lg border p-6"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-warning)" }}
        >
          <p className="text-sm font-semibold" style={{ color: "var(--wp-warning)" }}>
            Database not reachable
          </p>
          <p className="text-sm mt-2" style={{ color: "var(--wp-text-dim)" }}>
            Analytics depend on a live PostgreSQL connection. Once <code>DATABASE_URL</code> is set in production and the team starts using the system, this page will fill in automatically.
          </p>
        </div>
      </div>
    );
  }

  if (data.live_mode_empty) {
    return (
      <div className="max-w-5xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Analytics</h1>
        <div
          className="rounded-lg border p-6"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <p className="text-sm font-semibold" style={{ color: "var(--wp-text)" }}>
            No activity yet
          </p>
          <p className="text-sm mt-2" style={{ color: "var(--wp-text-dim)" }}>
            The system is connected but the team hasn&apos;t generated any tracked activity in the last 7 days. Ask the OGIAM Assistant a question, generate a doc, or connect an integration on the Settings page to start filling this in.
          </p>
          <a
            href="/settings"
            className="inline-block mt-3 text-sm font-medium"
            style={{ color: "var(--wp-gold)" }}
          >
            Go to Settings →
          </a>
        </div>
      </div>
    );
  }

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

      {/* Top stats — pulled from plain-language activity buckets so the
          team sees what's happening without needing to know dev jargon */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Zero-Token Rate"
          value={data.ai_efficiency ? `${data.ai_efficiency.zero_token_pct}%` : "—"}
          color="var(--wp-success)"
          hint="% of answers we served without paying for AI"
        />
        <StatCard
          label="Questions Asked"
          value={(data.activity_summary.find((a) => a.label === "Questions asked")?.count) || 0}
          color="var(--wp-info)"
          hint="Last 7 days"
        />
        <StatCard
          label="Documents Generated"
          value={(data.activity_summary.find((a) => a.label === "Documents generated")?.count) || 0}
          color="var(--wp-warning)"
          hint="Reports, proposals, client docs"
        />
        <StatCard
          label="Meetings Ingested"
          value={data.meeting_stats?.total_transcripts || 0}
          color="var(--wp-gold)"
          hint="Plaud transcripts in the team knowledge base"
        />
      </div>

      {/* Activity summary — plain language, no dev jargon */}
      <div
        className="rounded-lg border p-5"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
          What the team did this week
        </h2>
        <p className="text-xs mb-4" style={{ color: "var(--wp-text-muted)" }}>
          Last 7 days of activity, in plain language.
        </p>
        {data.activity_summary.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>No activity yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.activity_summary.map((b, i) => (
              <div
                key={i}
                className="p-3 rounded-lg"
                style={{ background: "var(--wp-dark-surface2)" }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>{b.label}</span>
                  <span className="text-base font-bold" style={{ color: "var(--wp-gold)" }}>{b.count}</span>
                </div>
                <p className="text-xs mt-1" style={{ color: "var(--wp-text-muted)" }}>
                  {b.description}
                </p>
              </div>
            ))}
          </div>
        )}
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
          <div className="flex items-center gap-4 mt-3 text-xs flex-wrap" style={{ color: "var(--wp-text-dim)" }}>
            <span>
              <span style={{ color: "var(--wp-success)" }}>{data.ai_efficiency.zero_token_answers}</span> answers from memory
            </span>
            <span>
              <span style={{ color: "var(--wp-info)" }}>{data.ai_efficiency.knowledge_savings}</span> from knowledge cache
            </span>
            <span>
              <span style={{ color: "var(--wp-gold)" }}>{data.ai_efficiency.meeting_savings}</span> from meetings
            </span>
            <span>
              <span style={{ color: "var(--wp-warning)" }}>{data.ai_efficiency.ai_calls}</span> AI calls
            </span>
          </div>
        </div>
      )}

      {/* Integration health */}
      {data.integration_health.length > 0 && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
            Integration health
          </h2>
          <p className="text-xs mb-4" style={{ color: "var(--wp-text-muted)" }}>
            Which connected tools have actually delivered data this week. Configured but inactive means it&apos;s set up but no events have arrived.
          </p>
          <div className="space-y-2">
            {data.integration_health.map((i) => (
              <div
                key={i.name}
                className="flex items-center justify-between p-3 rounded-lg"
                style={{ background: "var(--wp-dark-surface2)" }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      background: i.status === "active" ? "var(--wp-success)" : "var(--wp-text-muted)",
                    }}
                  />
                  <span className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>{i.label}</span>
                </div>
                <div className="text-xs flex items-center gap-3" style={{ color: "var(--wp-text-dim)" }}>
                  <span>{i.events_7d} events</span>
                  {i.last_event_at && (
                    <span>last {new Date(i.last_event_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Doc quality gate activity */}
      {data.gate_activity && data.gate_activity.total_checked > 0 && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
            Doc quality gate
          </h2>
          <p className="text-xs mb-4" style={{ color: "var(--wp-text-muted)" }}>
            Documents checked for PII, security risks, and compliance issues before they enter the knowledge base.
          </p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="p-3 rounded-lg text-center" style={{ background: "var(--wp-dark-surface2)" }}>
              <p className="text-2xl font-bold" style={{ color: "var(--wp-success)" }}>{data.gate_activity.passed}</p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>Passed</p>
            </div>
            <div className="p-3 rounded-lg text-center" style={{ background: "var(--wp-dark-surface2)" }}>
              <p className="text-2xl font-bold" style={{ color: "var(--wp-warning)" }}>{data.gate_activity.warned}</p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>Warned (PII redacted)</p>
            </div>
            <div className="p-3 rounded-lg text-center" style={{ background: "var(--wp-dark-surface2)" }}>
              <p className="text-2xl font-bold" style={{ color: "var(--wp-error)" }}>{data.gate_activity.rejected}</p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>Blocked</p>
            </div>
          </div>
          {data.gate_activity.recent_rejections.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: "var(--wp-text-dim)" }}>Recent blocks</p>
              <div className="space-y-2">
                {data.gate_activity.recent_rejections.map((r, i) => (
                  <div key={i} className="p-2 rounded text-xs" style={{ background: "var(--wp-dark-surface2)" }}>
                    <div className="flex justify-between gap-2">
                      <span className="font-medium truncate" style={{ color: "var(--wp-text)" }}>{r.file_name}</span>
                      <span style={{ color: "var(--wp-text-muted)" }}>
                        {new Date(r.when).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    <p className="mt-1" style={{ color: "var(--wp-text-muted)" }}>{r.reasons}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Meeting ingestion stats */}
      {data.meeting_stats && data.meeting_stats.total_transcripts > 0 && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
            Meeting transcripts
          </h2>
          <p className="text-xs mb-4" style={{ color: "var(--wp-text-muted)" }}>
            Plaud recordings ingested into the team knowledge base.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-lg text-center" style={{ background: "var(--wp-dark-surface2)" }}>
              <p className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>{data.meeting_stats.total_transcripts}</p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>Total</p>
            </div>
            <div className="p-3 rounded-lg text-center" style={{ background: "var(--wp-dark-surface2)" }}>
              <p className="text-2xl font-bold" style={{ color: "var(--wp-success)" }}>{data.meeting_stats.passed}</p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>Clean</p>
            </div>
            <div className="p-3 rounded-lg text-center" style={{ background: "var(--wp-dark-surface2)" }}>
              <p className="text-2xl font-bold" style={{ color: "var(--wp-warning)" }}>{data.meeting_stats.warned}</p>
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>PII redacted</p>
            </div>
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
                      <span>{member.user_name || member.user_id}</span>
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

      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: string | number;
  color: string;
  hint?: string;
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
      {hint && (
        <p className="text-xs mt-1" style={{ color: "var(--wp-text-muted)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}
