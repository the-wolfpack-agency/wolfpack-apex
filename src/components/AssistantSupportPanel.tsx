"use client";

import { useState, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

/**
 * Support-mode panel that hangs above the main /assistant chat.
 *
 * Calls POST /api/knowledge/ask with surface='assistant_support'. The
 * server-side semantic cache (migration 108) returns a cached answer
 * when one exists, otherwise it asks the LLM under the support system
 * prompt and writes the new Q/A row so the next person to ask gets a
 * free hit.
 *
 * UX rules:
 *   * The AI badge is shown whenever source === 'ai_generated', even on
 *     a cache hit. Users should always know the answer originated from
 *     a model — that's a literal user requirement (verbatim).
 *   * If the answer is low-confidence (server flag) we surface a
 *     "Submit a support ticket" CTA so the user has a clear escape
 *     hatch. Clicking the CTA emits the assistant.support_query event
 *     with fell_back_to_ticket=true so the learning loop can grade
 *     deflection rate over time.
 */

interface AskResponse {
  qa_id: string;
  answer: string;
  source: "ai_generated" | "internal_doc" | "human_curated";
  ai_model: string | null;
  ai_generated_at: string | null;
  was_cache_hit: boolean;
  similarity?: number;
  low_confidence: boolean;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export function AssistantSupportPanel() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<"helpful" | "not_helpful" | null>(
    null,
  );
  const [ticketCtaUsed, setTicketCtaUsed] = useState(false);

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setAnswer(null);
    setError(null);
    setFeedback(null);
    setTicketCtaUsed(false);
    try {
      const res = await fetchWithRefresh("/api/knowledge/ask", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          question: question.trim(),
          surface: "assistant_support",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          (data && (data as { error?: string }).error) ??
            "Sorry, support is not available right now.",
        );
      } else {
        const data = (await res.json()) as AskResponse;
        setAnswer(data);
      }
    } catch {
      setError("Network error.");
    }
    setLoading(false);
  }

  async function submitFeedback(helpful: boolean) {
    if (!answer || feedback) return;
    setFeedback(helpful ? "helpful" : "not_helpful");
    try {
      await fetchWithRefresh("/api/knowledge/feedback", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          qa_id: answer.qa_id,
          helpful,
          surface: "assistant_support",
        }),
      });
    } catch {
      /* best-effort */
    }
  }

  async function clickTicketCta() {
    if (!answer || ticketCtaUsed) return;
    setTicketCtaUsed(true);
    try {
      await fetchWithRefresh("/api/knowledge/feedback", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          qa_id: answer.qa_id,
          helpful: false,
          surface: "assistant_support",
          fell_back_to_ticket: true,
        }),
      });
    } catch {
      /* best-effort */
    }
    if (typeof window !== "undefined") {
      window.location.href = "/support?new=1";
    }
  }

  return (
    <div
      className="mx-4 my-3 rounded-lg border p-4"
      data-testid="assistant-support-panel"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <form onSubmit={ask} className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a support question (e.g. how do I rotate my password?)"
          aria-label="Support question"
          data-testid="assistant-support-input"
          className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          data-testid="assistant-support-submit"
          className="px-3 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      {error && (
        <p
          className="mt-3 text-sm"
          data-testid="assistant-support-error"
          style={{ color: "var(--wp-error)" }}
        >
          {error}
        </p>
      )}

      {answer && (
        <div className="mt-3" data-testid="assistant-support-answer">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {answer.source === "ai_generated" && (
              <span
                data-testid="assistant-support-ai-badge"
                className="text-xs px-2 py-0.5 rounded font-semibold"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                AI-generated answer
                {answer.ai_model ? ` • ${answer.ai_model}` : ""}
                {answer.ai_generated_at
                  ? ` • ${new Date(answer.ai_generated_at).toLocaleString()}`
                  : ""}
              </span>
            )}
            {answer.was_cache_hit && (
              <span
                data-testid="assistant-support-cache-badge"
                className="text-xs px-2 py-0.5 rounded"
                style={{
                  background: "var(--wp-success)20",
                  color: "var(--wp-success)",
                }}
              >
                cached
              </span>
            )}
            <span
              data-testid="assistant-support-tokens-badge"
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: "var(--wp-dark-surface2)",
                color: "var(--wp-text-dim)",
                border: "1px solid var(--wp-dark-border)",
              }}
              title={
                answer.was_cache_hit
                  ? "Served from cache — no model tokens used"
                  : `prompt ${answer.prompt_tokens ?? 0} + completion ${answer.completion_tokens ?? 0}`
              }
            >
              {answer.was_cache_hit
                ? "Zero tokens"
                : `${answer.total_tokens ?? 0} tokens`}
            </span>
          </div>
          <p
            className="text-sm whitespace-pre-wrap"
            style={{ color: "var(--wp-text)" }}
          >
            {answer.answer}
          </p>

          {answer.low_confidence && !ticketCtaUsed && (
            <button
              type="button"
              onClick={clickTicketCta}
              data-testid="assistant-support-ticket-cta"
              className="mt-3 text-sm px-3 py-1.5 rounded-lg font-semibold transition-colors border"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-gold)",
                color: "var(--wp-gold)",
              }}
            >
              Submit a support ticket
            </button>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => submitFeedback(true)}
              disabled={!!feedback}
              data-testid="assistant-support-helpful"
              className="text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50"
              style={{
                background:
                  feedback === "helpful"
                    ? "var(--wp-success)20"
                    : "var(--wp-dark-surface)",
                borderColor: "var(--wp-dark-border)",
                color:
                  feedback === "helpful"
                    ? "var(--wp-success)"
                    : "var(--wp-text)",
              }}
            >
              Helpful
            </button>
            <button
              type="button"
              onClick={() => submitFeedback(false)}
              disabled={!!feedback}
              data-testid="assistant-support-not-helpful"
              className="text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50"
              style={{
                background:
                  feedback === "not_helpful"
                    ? "var(--wp-error)20"
                    : "var(--wp-dark-surface)",
                borderColor: "var(--wp-dark-border)",
                color:
                  feedback === "not_helpful"
                    ? "var(--wp-error)"
                    : "var(--wp-text)",
              }}
            >
              Not helpful
            </button>
            {feedback && (
              <span
                className="text-xs"
                style={{ color: "var(--wp-text-dim)" }}
              >
                Thanks — recorded.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
