"use client";

import { useState, useEffect, useRef, KeyboardEvent } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: "user" | "assistant";
  content: string;
  source?: string;
  tokensUsed: number;
  timestamp: string;
  rating?: number;
}

interface Conversation {
  id: string;
  preview: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Source badge config
// ---------------------------------------------------------------------------

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  knowledge_cache: { label: "From knowledge base", color: "var(--wp-success)" },
  codebase: { label: "From codebase", color: "var(--wp-info)" },
  analytics: { label: "From analytics", color: "#a855f7" },
  ai: { label: "AI generated", color: "var(--wp-gold)" },
  fallback: { label: "No match found", color: "var(--wp-text-muted)" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AssistantPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  function authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    };
  }

  // Track page view
  useEffect(() => {
    fetch("/api/assistant", {
      headers: authHeaders(),
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input on load
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = {
      role: "user",
      content: trimmed,
      tokensUsed: 0,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          message: trimmed,
          conversationId,
        }),
      });

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json();

      if (!conversationId && data.conversationId) {
        setConversationId(data.conversationId);
        setConversations((prev) => [
          {
            id: data.conversationId,
            preview: trimmed.slice(0, 60),
            timestamp: new Date().toISOString(),
          },
          ...prev,
        ]);
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: data.response,
        source: data.source,
        tokensUsed: data.tokensUsed,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Something went wrong. Please try again.",
          source: "fallback",
          tokensUsed: 0,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleRate(msgIndex: number, rating: number) {
    if (!conversationId) return;

    setMessages((prev) =>
      prev.map((m, i) => (i === msgIndex ? { ...m, rating } : m)),
    );

    try {
      await fetch("/api/assistant", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          action: "rate",
          conversationId,
          messageIndex: msgIndex,
          rating,
        }),
      });
    } catch {
      // Rating failure is non-fatal
    }
  }

  function handleNewConversation() {
    setMessages([]);
    setConversationId(null);
    setInput("");
    inputRef.current?.focus();
  }

  async function loadConversation(convId: string) {
    try {
      const res = await fetch(`/api/assistant?conversationId=${convId}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversationId(convId);
      setMessages(data.messages || []);
      setSidebarOpen(false);
    } catch {
      // Load failure is non-fatal
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] lg:h-[calc(100vh-2rem)]">
      {/* Conversation sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-30 w-64 border-r flex flex-col transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <span className="text-sm font-medium" style={{ color: "var(--wp-text-dim)" }}>
            Conversations
          </span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1"
            style={{ color: "var(--wp-text-muted)" }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs" style={{ color: "var(--wp-text-muted)" }}>
              No conversations yet
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => loadConversation(c.id)}
                className="w-full text-left px-4 py-3 border-b text-sm transition-colors hover:opacity-80"
                style={{
                  borderColor: "var(--wp-dark-border)",
                  background: c.id === conversationId ? "var(--wp-dark-surface2)" : "transparent",
                  color: c.id === conversationId ? "var(--wp-gold)" : "var(--wp-text-dim)",
                }}
              >
                <p className="truncate">{c.preview}</p>
                <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                  {new Date(c.timestamp).toLocaleTimeString()}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b shrink-0"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-1"
            style={{ color: "var(--wp-text-dim)" }}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Brain icon */}
          <svg
            className="w-6 h-6 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{ color: "var(--wp-gold)" }}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
            />
          </svg>

          <h1 className="text-lg font-bold" style={{ color: "var(--wp-gold)" }}>
            Apex Assistant
          </h1>

          <div className="flex-1" />

          <button
            onClick={handleNewConversation}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text-dim)",
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New conversation
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <svg
                className="w-16 h-16 mb-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={0.5}
                style={{ color: "var(--wp-dark-border)" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
                />
              </svg>
              <h2 className="text-lg font-medium mb-2" style={{ color: "var(--wp-text-dim)" }}>
                Ask anything about Wolfpack
              </h2>
              <p className="text-sm max-w-md" style={{ color: "var(--wp-text-muted)" }}>
                Questions about the codebase, features, analytics, or platform.
                Answers from the knowledge base and codebase cost zero tokens.
              </p>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className="max-w-[80%] lg:max-w-[60%] rounded-xl px-4 py-3"
                style={{
                  background:
                    msg.role === "user"
                      ? "var(--wp-gold)"
                      : "var(--wp-dark-surface2)",
                  color:
                    msg.role === "user"
                      ? "var(--wp-dark)"
                      : "var(--wp-text)",
                }}
              >
                {/* Message content */}
                <div className="text-sm whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </div>

                {/* Assistant metadata */}
                {msg.role === "assistant" && msg.source && (
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {/* Source badge */}
                    {SOURCE_BADGE[msg.source] && (
                      <span
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{
                          background: `${SOURCE_BADGE[msg.source].color}20`,
                          color: SOURCE_BADGE[msg.source].color,
                        }}
                      >
                        {SOURCE_BADGE[msg.source].label}
                      </span>
                    )}

                    {/* Zero tokens badge */}
                    {msg.source !== "ai" && (
                      <span
                        className="inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{
                          background: "var(--wp-success)20",
                          color: "var(--wp-success)",
                        }}
                      >
                        Zero tokens
                      </span>
                    )}

                    {/* Token count for AI */}
                    {msg.source === "ai" && msg.tokensUsed > 0 && (
                      <span
                        className="text-xs"
                        style={{ color: "var(--wp-text-muted)" }}
                      >
                        {msg.tokensUsed.toLocaleString()} tokens
                      </span>
                    )}

                    {/* Rating buttons */}
                    <div className="flex items-center gap-1 ml-auto">
                      <button
                        onClick={() => handleRate(idx, 5)}
                        className="p-1 rounded transition-colors"
                        style={{
                          color: msg.rating === 5 ? "var(--wp-success)" : "var(--wp-text-muted)",
                        }}
                        title="Helpful"
                      >
                        <svg className="w-4 h-4" fill={msg.rating === 5 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75A2.25 2.25 0 0116.5 4.5c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904M14.25 9h2.25M5.904 18.75c.083.205.173.405.27.602.197.4-.078.898-.523.898h-.908c-.889 0-1.713-.518-1.972-1.368a12 12 0 01-.521-3.507c0-1.553.295-3.036.831-4.398C3.387 10.203 4.167 9.75 5 9.75h1.053c.472 0 .745.556.5.96a8.958 8.958 0 00-1.302 4.665c0 1.194.232 2.333.654 3.375z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleRate(idx, 1)}
                        className="p-1 rounded transition-colors"
                        style={{
                          color: msg.rating === 1 ? "var(--wp-error)" : "var(--wp-text-muted)",
                        }}
                        title="Not helpful"
                      >
                        <svg className="w-4 h-4" fill={msg.rating === 1 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 15h2.25m8.024-9.75c.011.05.028.1.052.148.591 1.2.924 2.55.924 3.977a8.96 8.96 0 01-1.302 4.666c-.245.403.028.959.5.959h1.053c.832 0 1.612-.453 1.918-1.227C21.705 12.661 22 11.355 22 10c0-1.553-.295-3.036-.831-4.398C20.613 4.547 19.833 4.1 19 4.1h-1.053c-.472 0-.745.556-.5.96a8.958 8.958 0 011.302 4.665c0 1.194-.232 2.333-.654 3.375M7.5 15l3.114 1.04a4.501 4.501 0 001.423.23h4.166c.618 0 1.217-.247 1.605-.729A11.95 11.95 0 0020.457 8.02c0-.435-.023-.863-.068-1.285C20.28 5.694 19.361 5 18.335 5h-3.126c-.618 0-.991-.724-.725-1.282A7.471 7.471 0 0015.207 .5.75.75 0 0014.457-.25 2.25 2.25 0 0012.207 2c0 .576.076 1.135.218 1.672.303.76.044 1.331-.612 1.716a9.041 9.041 0 00-2.86 2.398c-.498.634-1.226 1.08-2.032 1.08H5.904" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {loading && (
            <div className="flex justify-start">
              <div
                className="rounded-xl px-4 py-3"
                style={{ background: "var(--wp-dark-surface2)" }}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className="w-2 h-2 rounded-full animate-bounce"
                    style={{ background: "var(--wp-gold)", animationDelay: "0ms" }}
                  />
                  <div
                    className="w-2 h-2 rounded-full animate-bounce"
                    style={{ background: "var(--wp-gold)", animationDelay: "150ms" }}
                  />
                  <div
                    className="w-2 h-2 rounded-full animate-bounce"
                    style={{ background: "var(--wp-gold)", animationDelay: "300ms" }}
                  />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div
          className="shrink-0 border-t px-4 py-3"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <div className="flex items-end gap-2 max-w-4xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about the codebase, features, analytics..."
              rows={1}
              className="flex-1 resize-none rounded-xl px-4 py-3 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                color: "var(--wp-text)",
                border: "1px solid var(--wp-dark-border)",
                maxHeight: "120px",
              }}
              disabled={loading}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="shrink-0 rounded-xl px-4 py-3 text-sm font-medium transition-opacity disabled:opacity-40"
              style={{
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
              }}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
          <p className="text-center text-xs mt-2" style={{ color: "var(--wp-text-muted)" }}>
            Cmd+Enter to send
          </p>
        </div>
      </div>
    </div>
  );
}
