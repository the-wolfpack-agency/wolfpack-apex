"use client";

/**
 * /meetings/feeds/[slug]/messages/[messageId] — single message view.
 *
 * Sections, top to bottom:
 *   - Subject + envelope
 *   - Insights (Phase 2 LLM analyzer): decisions, action items, topics,
 *     blockers, next steps. Loading state while analyzer runs;
 *     "Re-analyze" button (meetings.manage only).
 *   - Body
 *   - Attachments
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Feed {
  id: string;
  slug: string;
  name: string;
}

interface Message {
  id: string;
  subject: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  received_at: string;
  body_text: string;
  has_attachments: boolean;
}

interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  extracted_text: string | null;
  extraction_status: "extracted" | "unsupported_mime" | "error";
}

interface AnalysisDecision {
  summary: string;
  rationale?: string;
  owners?: string[];
  source_quote?: string;
}
interface AnalysisActionItem {
  description: string;
  owner?: string;
  due?: string;
  completed?: boolean;
  source_quote?: string;
}
interface AnalysisAttendee {
  name?: string;
  email?: string;
  role?: string;
}
interface AnalysisBlocker {
  description: string;
  severity?: "low" | "medium" | "high";
}
interface AnalysisNextStep {
  description: string;
  when?: string;
}

interface Analysis {
  id: string;
  message_id: string;
  analyzer_version: string;
  analyzed_at: string;
  decisions: AnalysisDecision[];
  action_items: AnalysisActionItem[];
  topics: string[];
  attendees: AnalysisAttendee[];
  blockers: AnalysisBlocker[];
  next_steps: AnalysisNextStep[];
  status: "success" | "partial" | "error";
  error_detail: string | null;
  model: string | null;
  tokens_used: number | null;
}

export default function MeetingMessageDetailPage() {
  const params = useParams<{ slug: string; messageId: string }>();
  const slug = params?.slug ?? "";
  const messageId = params?.messageId ?? "";

  const [feed, setFeed] = useState<Feed | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analyzerAvailable, setAnalyzerAvailable] = useState(true);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);

  const loadAnalysis = useCallback(async () => {
    if (!slug || !messageId) return;
    setAnalysisLoading(true);
    try {
      const res = await fetchWithRefresh(
        `/api/meetings/feeds/${slug}/messages/${messageId}/analysis`,
      );
      if (res.status === 401) {
        window.location.href = `/login?next=/meetings/feeds/${slug}/messages/${messageId}`;
        return;
      }
      if (!res.ok) {
        setAnalysis(null);
        return;
      }
      const data = (await res.json()) as {
        analysis: Analysis | null;
        analyzer_available: boolean;
      };
      setAnalysis(data.analysis);
      setAnalyzerAvailable(data.analyzer_available);
    } catch {
      setAnalysis(null);
    } finally {
      setAnalysisLoading(false);
    }
  }, [slug, messageId]);

  useEffect(() => {
    if (!slug || !messageId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchWithRefresh(
          `/api/meetings/feeds/${slug}/messages/${messageId}`,
        );
        if (res.status === 401) {
          window.location.href = `/login?next=/meetings/feeds/${slug}/messages/${messageId}`;
          return;
        }
        if (res.status === 404) {
          setError("Message not found");
          return;
        }
        if (!res.ok) {
          setError(`Failed to load message (${res.status})`);
          return;
        }
        const data = (await res.json()) as {
          feed: Feed;
          message: Message;
          attachments: Attachment[];
        };
        setFeed(data.feed);
        setMessage(data.message);
        setAttachments(data.attachments);
      } catch (err) {
        setError(`Network error: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
    loadAnalysis();
  }, [slug, messageId, loadAnalysis]);

  const reanalyze = useCallback(async () => {
    if (!slug || !messageId) return;
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/meetings/feeds/${slug}/messages/${messageId}/analysis/regenerate`,
        { method: "POST" },
      );
      if (res.status === 401) {
        window.location.href = `/login?next=/meetings/feeds/${slug}/messages/${messageId}`;
        return;
      }
      if (res.status === 403) {
        setReanalyzeError("You don't have permission to re-analyze.");
        return;
      }
      if (res.status === 429) {
        setReanalyzeError("Rate limited — wait a moment before retrying.");
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setReanalyzeError(data.error ?? `Re-analyze failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { analysis: Analysis };
      setAnalysis(data.analysis);
    } catch (err) {
      setReanalyzeError(`Network error: ${(err as Error).message}`);
    } finally {
      setReanalyzing(false);
    }
  }, [slug, messageId]);

  if (loading) {
    return <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ padding: "2rem", color: "var(--wp-error)" }}>{error}</div>;
  }
  if (!message || !feed) {
    return <div style={{ padding: "2rem", color: "var(--wp-error)" }}>Message not found</div>;
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <Link
        href={`/meetings/feeds/${slug}`}
        style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", textDecoration: "none" }}
      >
        ← {feed.name}
      </Link>

      <h1
        data-testid="meeting-message-subject"
        style={{ fontSize: "1.5rem", marginTop: "0.75rem" }}
      >
        {message.subject || "(no subject)"}
      </h1>

      <div
        style={{
          background: "var(--wp-card)",
          border: "1px solid var(--wp-border)",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          color: "var(--wp-text-dim)",
          fontSize: "0.85rem",
          marginTop: "0.75rem",
        }}
      >
        <div>
          <strong style={{ color: "var(--wp-text)" }}>From:</strong>{" "}
          {message.from_name
            ? `${message.from_name} <${message.from_address}>`
            : message.from_address}
        </div>
        <div style={{ marginTop: "0.3rem" }}>
          <strong style={{ color: "var(--wp-text)" }}>To:</strong>{" "}
          {message.to_addresses.join(", ") || "(none)"}
        </div>
        {message.cc_addresses.length > 0 && (
          <div style={{ marginTop: "0.3rem" }}>
            <strong style={{ color: "var(--wp-text)" }}>Cc:</strong>{" "}
            {message.cc_addresses.join(", ")}
          </div>
        )}
        <div style={{ marginTop: "0.3rem" }}>
          <strong style={{ color: "var(--wp-text)" }}>Received:</strong>{" "}
          {new Date(message.received_at).toLocaleString()}
        </div>
      </div>

      {/* ---------- Insights (Phase 2) ---------- */}
      <InsightsSection
        analysis={analysis}
        loading={analysisLoading}
        analyzerAvailable={analyzerAvailable}
        reanalyzing={reanalyzing}
        reanalyzeError={reanalyzeError}
        onReanalyze={reanalyze}
      />

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Body</h2>
        {message.body_text ? (
          <pre
            data-testid="meeting-message-body"
            style={{
              background: "var(--wp-card)",
              border: "1px solid var(--wp-border)",
              borderRadius: "8px",
              padding: "1rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--wp-text)",
              fontFamily: "inherit",
              fontSize: "0.9rem",
              margin: 0,
            }}
          >
            {message.body_text}
          </pre>
        ) : (
          <div style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}>
            (Body text pending — Stream B parser not yet merged.)
          </div>
        )}
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Attachments ({attachments.length})
        </h2>
        {attachments.length === 0 ? (
          <div style={{ color: "var(--wp-text-dim)" }}>No attachments.</div>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }} data-testid="meeting-attachments-list">
            {attachments.map((att) => (
              <div
                key={att.id}
                style={{
                  background: "var(--wp-card)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                }}
              >
                <div style={{ fontWeight: 600 }}>{att.filename}</div>
                <div
                  style={{
                    color: "var(--wp-text-dim)",
                    fontSize: "0.8rem",
                    marginTop: "0.3rem",
                  }}
                >
                  {att.mime} · {Math.round(att.size_bytes / 1024)} KB ·{" "}
                  {att.extraction_status}
                </div>
                {att.extracted_text && (
                  <details style={{ marginTop: "0.5rem" }}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontSize: "0.85rem",
                        color: "var(--wp-text-dim)",
                      }}
                    >
                      Extracted text
                    </summary>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        fontSize: "0.85rem",
                        marginTop: "0.4rem",
                      }}
                    >
                      {att.extracted_text}
                    </pre>
                  </details>
                )}
                <div style={{ marginTop: "0.5rem" }}>
                  <a
                    href={`/api/meetings/feeds/${slug}/messages/${messageId}/attachments/${att.id}/download`}
                    style={{
                      color: "var(--wp-gold)",
                      fontSize: "0.85rem",
                      textDecoration: "none",
                    }}
                  >
                    Download (requires meetings.export)
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Insights component                                                  */
/* ------------------------------------------------------------------ */

function InsightsSection({
  analysis,
  loading,
  analyzerAvailable,
  reanalyzing,
  reanalyzeError,
  onReanalyze,
}: {
  analysis: Analysis | null;
  loading: boolean;
  analyzerAvailable: boolean;
  reanalyzing: boolean;
  reanalyzeError: string | null;
  onReanalyze: () => void;
}) {
  return (
    <section
      data-testid="meeting-insights"
      style={{
        marginTop: "1.5rem",
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: "8px",
        padding: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: 0 }}>Insights</h2>
        <button
          type="button"
          data-testid="meeting-insights-reanalyze"
          onClick={onReanalyze}
          disabled={reanalyzing || !analyzerAvailable}
          style={{
            background: "transparent",
            border: "1px solid var(--wp-border)",
            color: "var(--wp-text-dim)",
            borderRadius: "6px",
            padding: "0.3rem 0.6rem",
            fontSize: "0.8rem",
            cursor: reanalyzing || !analyzerAvailable ? "not-allowed" : "pointer",
          }}
        >
          {reanalyzing ? "Re-analyzing…" : "Re-analyze"}
        </button>
      </div>

      {!analyzerAvailable && (
        <div
          data-testid="meeting-insights-unavailable"
          style={{
            color: "var(--wp-error)",
            fontSize: "0.85rem",
            marginTop: "0.5rem",
          }}
        >
          ANTHROPIC_API_KEY is not configured — insights are disabled.
        </div>
      )}

      {reanalyzeError && (
        <div
          style={{
            color: "var(--wp-error)",
            fontSize: "0.85rem",
            marginTop: "0.5rem",
          }}
        >
          {reanalyzeError}
        </div>
      )}

      {loading && !analysis ? (
        <div
          data-testid="meeting-insights-loading"
          style={{
            color: "var(--wp-text-dim)",
            fontStyle: "italic",
            marginTop: "0.5rem",
          }}
        >
          Analysing…
        </div>
      ) : !analysis ? (
        <div
          data-testid="meeting-insights-empty"
          style={{
            color: "var(--wp-text-dim)",
            fontStyle: "italic",
            marginTop: "0.5rem",
          }}
        >
          Awaiting analysis. Click Re-analyze to run now.
        </div>
      ) : (
        <InsightsBody analysis={analysis} />
      )}
    </section>
  );
}

function InsightsBody({ analysis }: { analysis: Analysis }) {
  const empty =
    analysis.decisions.length === 0 &&
    analysis.action_items.length === 0 &&
    analysis.topics.length === 0 &&
    analysis.blockers.length === 0 &&
    analysis.next_steps.length === 0;

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {analysis.status !== "success" && (
        <div
          style={{
            color: "var(--wp-error)",
            fontSize: "0.85rem",
            marginBottom: "0.5rem",
          }}
        >
          Analysis status: {analysis.status}
          {analysis.error_detail ? ` — ${analysis.error_detail}` : ""}
        </div>
      )}

      {analysis.topics.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }} data-testid="insights-topics">
          <strong style={{ fontSize: "0.85rem" }}>Topics:</strong>{" "}
          {analysis.topics.map((t) => (
            <span
              key={t}
              style={{
                display: "inline-block",
                background: "var(--wp-bg)",
                border: "1px solid var(--wp-border)",
                borderRadius: "12px",
                padding: "0.15rem 0.55rem",
                margin: "0.15rem",
                fontSize: "0.8rem",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {analysis.decisions.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }} data-testid="insights-decisions">
          <strong style={{ fontSize: "0.85rem" }}>Decisions</strong>
          <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0 }}>
            {analysis.decisions.map((d, i) => (
              <li key={i} style={{ marginBottom: "0.3rem" }}>
                {d.summary}
                {d.owners && d.owners.length > 0 ? ` (${d.owners.join(", ")})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.action_items.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }} data-testid="insights-action-items">
          <strong style={{ fontSize: "0.85rem" }}>Action items</strong>
          <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, listStyle: "none" }}>
            {analysis.action_items.map((a, i) => (
              <li key={i} style={{ marginBottom: "0.3rem" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "0.5rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(a.completed)}
                    readOnly
                    aria-label={`action item ${i + 1} completed`}
                    style={{ marginTop: "0.2rem" }}
                  />
                  <span>
                    {a.description}
                    {a.owner ? ` — ${a.owner}` : ""}
                    {a.due ? ` (due ${a.due})` : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.blockers.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }} data-testid="insights-blockers">
          <strong style={{ fontSize: "0.85rem" }}>Blockers</strong>
          <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0 }}>
            {analysis.blockers.map((b, i) => (
              <li key={i} style={{ marginBottom: "0.3rem" }}>
                {b.description}
                {b.severity ? ` [${b.severity}]` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.next_steps.length > 0 && (
        <div style={{ marginBottom: "0.25rem" }} data-testid="insights-next-steps">
          <strong style={{ fontSize: "0.85rem" }}>Next steps</strong>
          <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0 }}>
            {analysis.next_steps.map((n, i) => (
              <li key={i} style={{ marginBottom: "0.3rem" }}>
                {n.description}
                {n.when ? ` — ${n.when}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {empty && (
        <div
          data-testid="insights-no-signal"
          style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}
        >
          No signal extracted from this message.
        </div>
      )}

      <div
        style={{
          marginTop: "0.75rem",
          color: "var(--wp-text-dim)",
          fontSize: "0.75rem",
        }}
      >
        v{analysis.analyzer_version}
        {analysis.model ? ` · ${analysis.model}` : ""}
        {analysis.tokens_used != null
          ? ` · ${analysis.tokens_used} tokens`
          : ""}
        {analysis.analyzed_at
          ? ` · ${new Date(analysis.analyzed_at).toLocaleString()}`
          : ""}
      </div>
    </div>
  );
}
