"use client";

/**
 * /assistant — Instinct Assistant.
 *
 * This page wraps a lightweight chat UI that talks directly to
 * /api/assistant. Unlike the floating InstinctChat bubble, this
 * full-page surface renders two extra affordances on every answer:
 *
 *   1. "Related pages" chip row — keyword-derived deep links into the
 *      in-app domains the user's question touches (calendar, goals,
 *      features, etc.). Fires `assistant.link_clicked` with { domain }
 *      so the learning loop can grade click-through.
 *
 *   2. Collapsible "Sources" block — shows the doc ids + titles that
 *      grounded the answer (knowledge base, brain chunks, tool-call
 *      attribution like "From Microsoft 365 · your calendar"). Fires
 *      `assistant.source_viewed` with { source_type } on expansion or
 *      click.
 *
 * Both affordances are zero-token: the server pre-computes them and
 * returns them in the /api/assistant payload.
 */

import { useEffect, useRef, useState, KeyboardEvent, FormEvent } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface RelatedPage {
  domain: string;
  label: string;
  href: string;
}

interface AssistantSource {
  id: string;
  title: string;
  url: string;
  type: string;
}

interface AssistantApiResponse {
  response?: string;
  answer?: string;
  source?: string;
  sources?: AssistantSource[];
  relatedPages?: RelatedPage[];
  tokensUsed?: number;
  conversationId?: string | null;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  source?: string;
  sources: AssistantSource[];
  relatedPages: RelatedPage[];
}

/** Fire-and-forget analytics beacon — reuses the shared /api/analytics
 *  endpoint and authenticated fetch wrapper. Never blocks the UI. */
function track(
  event: "assistant.link_clicked" | "assistant.source_viewed",
  metadata: Record<string, string | number | boolean>,
): void {
  try {
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event, metadata }),
    }).catch(() => {});
  } catch {
    /* never throw from a tracking call */
  }
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      sources: [],
      relatedPages: [],
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetchWithRefresh("/api/assistant", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          message: trimmed,
          conversationId,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: "Sorry — the assistant is unavailable right now. Please try again.",
            sources: [],
            relatedPages: [],
          },
        ]);
        return;
      }

      const data = (await res.json()) as AssistantApiResponse;
      const answer = data.response || data.answer || "";
      if (data.conversationId !== undefined) {
        setConversationId(data.conversationId);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: answer,
          source: data.source,
          sources: Array.isArray(data.sources) ? data.sources : [],
          relatedPages: Array.isArray(data.relatedPages) ? data.relatedPages : [],
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: "Sorry — the assistant is unavailable right now. Please try again.",
          sources: [],
          relatedPages: [],
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  function toggleSources(msgId: string, sourceType: string) {
    setExpandedSources((prev) => {
      const next = { ...prev, [msgId]: !prev[msgId] };
      return next;
    });
    track("assistant.source_viewed", { source_type: sourceType });
  }

  return (
    <div
      className="max-w-4xl mx-auto flex flex-col"
      style={{ height: "calc(100vh - 120px)" }}
      data-testid="assistant-page"
    >
      <h1 className="text-2xl font-bold mb-4" style={{ color: "var(--wp-gold)" }}>
        Assistant
      </h1>

      <div
        className="flex-1 overflow-y-auto rounded-lg border p-4 space-y-4"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
        data-testid="assistant-messages"
      >
        {messages.length === 0 && (
          <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
            Ask a question — I will pull from your knowledge base, your calendar, your
            goals, and the rest of Instinct before touching any AI.
          </p>
        )}

        {messages.map((m) => (
          <div key={m.id} data-testid={`assistant-msg-${m.role}`}>
            <div
              className="rounded-lg px-4 py-3 text-sm whitespace-pre-wrap"
              style={{
                background:
                  m.role === "user"
                    ? "var(--wp-dark-surface2)"
                    : "rgba(234,179,8,0.08)",
                color: "var(--wp-text)",
              }}
            >
              {m.content}
            </div>

            {m.role === "assistant" && m.relatedPages.length > 0 && (
              <div
                className="mt-2 flex flex-wrap gap-2"
                data-testid={`related-pages-${m.id}`}
              >
                <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                  Related pages:
                </span>
                {m.relatedPages.map((rp) => (
                  <a
                    key={rp.href}
                    href={rp.href}
                    onClick={() => track("assistant.link_clicked", { domain: rp.domain })}
                    className="text-xs px-2 py-1 rounded-full border transition-colors hover:border-[var(--wp-gold)]"
                    data-testid={`related-chip-${rp.domain}`}
                    style={{
                      background: "var(--wp-dark-surface2)",
                      borderColor: "var(--wp-dark-border)",
                      color: "var(--wp-gold)",
                      textDecoration: "none",
                    }}
                  >
                    {rp.label}
                  </a>
                ))}
              </div>
            )}

            {m.role === "assistant" && m.sources.length > 0 && (
              <div className="mt-2" data-testid={`sources-block-${m.id}`}>
                <button
                  type="button"
                  onClick={() =>
                    toggleSources(m.id, m.sources[0]?.type ?? "unknown")
                  }
                  className="text-xs underline"
                  style={{ color: "var(--wp-text-muted)" }}
                  data-testid={`sources-toggle-${m.id}`}
                >
                  {expandedSources[m.id] ? "Hide" : "Show"} {m.sources.length}{" "}
                  source{m.sources.length === 1 ? "" : "s"}
                </button>
                {expandedSources[m.id] && (
                  <ul
                    className="mt-2 space-y-1"
                    data-testid={`sources-list-${m.id}`}
                  >
                    {m.sources.map((s) => (
                      <li key={s.id} className="text-xs">
                        <a
                          href={s.url}
                          onClick={() =>
                            track("assistant.source_viewed", { source_type: s.type })
                          }
                          className="underline"
                          style={{ color: "var(--wp-gold)", textDecoration: "underline" }}
                          data-testid={`source-link-${s.id}`}
                        >
                          {s.title}
                        </a>{" "}
                        <span style={{ color: "var(--wp-text-muted)" }}>· {s.type}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            Thinking…
          </p>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask about your calendar, goals, features, clients…"
          rows={2}
          className="flex-1 rounded-lg border px-4 py-3 text-sm outline-none resize-none"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
          data-testid="assistant-input"
        />
        <button
          type="submit"
          disabled={loading || input.trim().length === 0}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          data-testid="assistant-send"
        >
          {loading ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
