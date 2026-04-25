"use client";

/**
 * /meetings/analyze — Phase 5 ad-hoc multi-term analysis surface.
 *
 * Form: subject filters (multi-input), sender filters (multi-input),
 * date range, optional attachments toggle. Submits to
 * POST /api/meetings/analyze and renders aggregated themes / actions
 * / decisions over the matching already-ingested messages.
 *
 * "Save as feed" redirects to /meetings/feeds with a `prefill=`
 * query param so the create form can rehydrate.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface MatchedMessage {
  id: string;
  feed_id: string;
  feed_slug: string;
  feed_name: string;
  subject: string;
  from_address: string;
  received_at: string;
  has_analysis: boolean;
}

interface ThemeRow {
  topic: string;
  mention_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

interface ActionRow {
  description: string;
  assignee?: string | null;
  due?: string | null;
  source_message_id?: string | null;
}

interface DecisionRow {
  description: string;
  decided_by?: string | null;
  source_message_id?: string | null;
}

interface AnalyzeResponse {
  matched_messages: MatchedMessage[];
  aggregated_themes: ThemeRow[];
  aggregated_action_items: ActionRow[];
  aggregated_decisions: DecisionRow[];
  counts: {
    matched: number;
    analyzed: number;
    feeds_touched: number;
  };
  filters: {
    subject_match: string[];
    sender_match: string[];
    since?: string;
    until?: string;
    include_attachments?: boolean;
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function MeetingsAnalyzePage() {
  const router = useRouter();

  const [subjects, setSubjects] = useState("");
  const [senders, setSenders] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [livePull, setLivePull] = useState(true);

  interface LivePullMatch {
    source_message_id: string;
    subject: string;
    from_address: string;
    from_name: string | null;
    received_at: string;
    body_preview: string;
    has_attachments: boolean;
  }
  type ResponseWithLive = AnalyzeResponse & {
    live_pull?: {
      enabled: boolean;
      skipped: boolean;
      skipped_reason?: string;
      inbox_seen: number;
      truncated: boolean;
      matches: LivePullMatch[];
    };
  };

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResponseWithLive | null>(null);

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    setSubmitting(true);
    setResult(null);
    try {
      const subjectArr = splitCsv(subjects);
      const senderArr = splitCsv(senders);
      const res = await fetchWithRefresh("/api/meetings/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_match: subjectArr,
          sender_match: senderArr,
          since: since || undefined,
          until: until || undefined,
          include_attachments: includeAttachments,
          live_pull: livePull,
        }),
      });
      if (res.status === 401) {
        window.location.href = "/login?next=/meetings/analyze";
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        setError(body?.detail || body?.error || `Analyze failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as AnalyzeResponse;
      setResult(data);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSaveAsFeed() {
    if (!result) return;
    const prefill = encodeURIComponent(
      JSON.stringify({
        subject_match: result.filters.subject_match,
        sender_match: result.filters.sender_match,
      }),
    );
    router.push(`/meetings/feeds?prefill=${prefill}`);
  }

  return (
    <div
      style={{ padding: "2rem", color: "var(--wp-text)", maxWidth: 960 }}
      data-testid="meetings-analyze-page"
    >
      <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Ad-hoc analysis</h1>
      <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
        Aggregate themes, action items and decisions across already-ingested
        meeting messages. No new email polling — query against what feeds
        have already captured.
      </p>

      <form
        onSubmit={handleSubmit}
        data-testid="meetings-analyze-form"
        style={{
          marginTop: "1.25rem",
          padding: "1rem 1.25rem",
          background: "var(--wp-card)",
          border: "1px solid var(--wp-border)",
          borderRadius: 8,
          display: "grid",
          gap: "0.75rem",
        }}
      >
        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
            Subject substrings (comma or newline separated)
          </span>
          <textarea
            data-testid="analyze-subjects"
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
            rows={2}
            placeholder="Stand-up, weekly review"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
            Sender substrings (comma or newline separated)
          </span>
          <textarea
            data-testid="analyze-senders"
            value={senders}
            onChange={(e) => setSenders(e.target.value)}
            rows={2}
            placeholder="@example.com, weekly-bot@example.com"
            style={inputStyle}
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
              Since
            </span>
            <input
              data-testid="analyze-since"
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
              Until
            </span>
            <input
              data-testid="analyze-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              style={inputStyle}
            />
          </label>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            data-testid="analyze-include-attachments"
            type="checkbox"
            checked={includeAttachments}
            onChange={(e) => setIncludeAttachments(e.target.checked)}
          />
          <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
            Include attachment text in the dataset (best-effort)
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 4 }}>
          <input
            data-testid="analyze-live-pull"
            type="checkbox"
            checked={livePull}
            onChange={(e) => setLivePull(e.target.checked)}
            style={{ marginTop: 4 }}
          />
          <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", lineHeight: 1.4 }}>
            <strong style={{ color: "var(--wp-text)" }}>
              Also scan my live Outlook inbox
            </strong>
            <br />
            One-shot Microsoft Graph query against the same filters. Returns
            matching emails sitting in your inbox right now (with subject /
            from / date / preview) even if they haven't been ingested into a
            feed yet. No LLM, no persistence — just visibility.
          </span>
        </label>
        {error && (
          <div
            data-testid="analyze-error"
            style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
          >
            {error}
          </div>
        )}
        <div>
          <button
            type="submit"
            data-testid="analyze-submit"
            disabled={submitting}
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              borderRadius: 8,
              padding: "0.5rem 1rem",
              fontWeight: 600,
              cursor: "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Analyzing…" : "Analyze"}
          </button>
        </div>
      </form>

      {submitting && (
        <p data-testid="analyze-loading" style={{ marginTop: "1rem", color: "var(--wp-text-dim)" }}>
          Running aggregation…
        </p>
      )}

      {result && !submitting && (
        <div data-testid="analyze-results" style={{ marginTop: "1.5rem", display: "grid", gap: "1rem" }}>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <Stat label="Matched messages" value={String(result.counts.matched)} />
            <Stat label="With analysis" value={String(result.counts.analyzed)} />
            <Stat label="Feeds touched" value={String(result.counts.feeds_touched)} />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              data-testid="analyze-save-as-feed"
              onClick={handleSaveAsFeed}
              style={{
                background: "transparent",
                color: "var(--wp-gold)",
                border: "1px solid var(--wp-gold)",
                borderRadius: 8,
                padding: "0.4rem 0.9rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Save this as a recurring feed
            </button>
          </div>

          {result.live_pull && (
            <Section
              title={
                result.live_pull.skipped
                  ? "Live inbox scan — skipped"
                  : `Live inbox matches (${result.live_pull.matches.length}${result.live_pull.truncated ? "+" : ""})`
              }
              testid="analyze-live-pull-section"
            >
              {result.live_pull.skipped ? (
                <p style={emptyStyle}>
                  {result.live_pull.skipped_reason === "no_user_connected"
                    ? "Connect Microsoft (top-right) and grant Mail.Read access, then re-run."
                    : `Skipped: ${result.live_pull.skipped_reason ?? "unknown"}`}
                </p>
              ) : result.live_pull.matches.length === 0 ? (
                <p style={emptyStyle}>
                  Scanned {result.live_pull.inbox_seen} recent inbox messages,
                  none matched the typed filters.
                </p>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  <p
                    style={{
                      ...emptyStyle,
                      marginBottom: 4,
                      fontStyle: "normal",
                    }}
                  >
                    Live matches from your Outlook inbox (NOT yet ingested into
                    a feed). Save this as a feed above to capture future
                    messages and run analysis.
                  </p>
                  {result.live_pull.matches.map((m) => (
                    <div
                      key={m.source_message_id}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "var(--wp-card)",
                        border: "1px solid var(--wp-border)",
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: "0.9rem" }}>{m.subject}</strong>
                        <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>
                          {new Date(m.received_at).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.78rem", color: "var(--wp-text-dim)", marginTop: 2 }}>
                        From: {m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address}
                        {m.has_attachments ? " · 📎" : ""}
                      </div>
                      {m.body_preview && (
                        <p style={{ fontSize: "0.82rem", marginTop: 6, color: "var(--wp-text)", lineHeight: 1.45 }}>
                          {m.body_preview.length > 280
                            ? m.body_preview.slice(0, 280) + "…"
                            : m.body_preview}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          <Section title={`Top themes (${result.aggregated_themes.length})`} testid="analyze-themes">
            {result.aggregated_themes.length === 0 ? (
              <p style={emptyStyle}>No analyzed messages in this set yet.</p>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {result.aggregated_themes.map((t) => (
                  <span
                    key={t.topic}
                    style={{
                      background: "var(--wp-dark-surface)",
                      border: "1px solid var(--wp-dark-border)",
                      borderRadius: 999,
                      padding: "0.2rem 0.6rem",
                      fontSize: "0.85rem",
                    }}
                  >
                    {t.topic}{" "}
                    <span style={{ color: "var(--wp-text-dim)" }}>×{t.mention_count}</span>
                  </span>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={`Action items (${result.aggregated_action_items.length})`}
            testid="analyze-actions"
          >
            {result.aggregated_action_items.length === 0 ? (
              <p style={emptyStyle}>No action items aggregated.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
                {result.aggregated_action_items.map((a, i) => (
                  <li key={`${a.description}-${i}`} style={{ fontSize: "0.9rem" }}>
                    <span style={{ color: "var(--wp-text-dim)", marginRight: 6 }}>☐</span>
                    {a.description}
                    {a.assignee && (
                      <span style={{ color: "var(--wp-text-muted)", marginLeft: 6 }}>
                        ({a.assignee})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title={`Decisions (${result.aggregated_decisions.length})`}
            testid="analyze-decisions"
          >
            {result.aggregated_decisions.length === 0 ? (
              <p style={emptyStyle}>No decisions aggregated.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
                {result.aggregated_decisions.map((d, i) => (
                  <li key={`${d.description}-${i}`} style={{ fontSize: "0.9rem" }}>
                    {d.description}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title={`Matched messages (${result.matched_messages.length})`}
            testid="analyze-messages"
          >
            {result.matched_messages.length === 0 ? (
              <p style={emptyStyle}>No messages matched these filters.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--wp-text-dim)" }}>
                    <th style={cellHead}>Subject</th>
                    <th style={cellHead}>From</th>
                    <th style={cellHead}>Received</th>
                    <th style={cellHead}>Feed</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matched_messages.slice(0, 100).map((m) => (
                    <tr key={m.id}>
                      <td style={cell}>
                        <Link
                          href={`/meetings/feeds/${m.feed_slug}/messages/${m.id}`}
                          style={{ color: "var(--wp-text)", textDecoration: "underline" }}
                        >
                          {m.subject || "(no subject)"}
                        </Link>
                      </td>
                      <td style={cell}>{m.from_address}</td>
                      <td style={cell}>{new Date(m.received_at).toLocaleDateString()}</td>
                      <td style={cell}>
                        <Link
                          href={`/meetings/feeds/${m.feed_slug}`}
                          style={{ color: "var(--wp-gold)", textDecoration: "none" }}
                        >
                          {m.feed_name}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--wp-dark-surface2)",
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 8,
        padding: "0.6rem 1rem",
        minWidth: 140,
      }}
    >
      <div style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--wp-gold)" }}>{value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>{label}</div>
    </div>
  );
}

function Section({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testid}
      style={{
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: 8,
        padding: "1rem 1.25rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: 0, color: "var(--wp-gold)" }}>{title}</h2>
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 8,
  padding: "0.5rem 0.75rem",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
  width: "100%",
  fontFamily: "inherit",
};

const cellHead: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  fontWeight: 600,
  fontSize: "0.8rem",
};
const cell: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
};
const emptyStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--wp-text-dim)",
  margin: 0,
};
