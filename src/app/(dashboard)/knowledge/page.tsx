"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders } from "@/lib/client-auth";

interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  source: string;
  asked_by: string;
  confidence: number;
  rating: number | null;
  view_count: number;
  tokens_used: number;
  tags: string[];
  created_at: string;
}

const SOURCE_COLORS: Record<string, string> = {
  cache: "var(--wp-success)",
  docs: "var(--wp-info)",
  codebase: "var(--wp-warning)",
  ai: "var(--wp-error)",
  human: "var(--wp-gold)",
};

export default function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [showAsk, setShowAsk] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<{ answer: KnowledgeEntry | null; source: string } | null>(null);

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchEntries();
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "knowledge" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchEntries(q?: string) {
    setLoading(true);
    try {
      const url = q ? `/api/knowledge?q=${encodeURIComponent(q)}` : "/api/knowledge?popular=true";
      const res = await fetch(url, { headers: authHeaders() });
      const data = await res.json();
      setEntries(data.entries || []);
    } catch {
      setEntries([]);
    }
    setLoading(false);
  }

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    fetchEntries(search || undefined);
  }

  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setAskResult(null);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      setAskResult({ answer: data.answer, source: data.source });
    } catch {
      setAskResult({ answer: null, source: "error" });
    }
    setAsking(false);
  }

  async function handleRate(entryId: string, rating: number) {
    // Optimistic UI
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, rating } : e))
    );
    if (selected?.id === entryId) setSelected({ ...selected, rating });

    // No dedicated rate endpoint yet, so just track it
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        event: "knowledge.answer_rated",
        metadata: { knowledge_id: entryId, rating },
      }),
    }).catch(() => {});
  }

  function renderStars(entry: KnowledgeEntry) {
    return (
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            onClick={(e) => {
              e.stopPropagation();
              handleRate(entry.id, star);
            }}
            className="text-sm transition-colors"
            style={{
              color: entry.rating && star <= entry.rating ? "var(--wp-gold)" : "var(--wp-dark-border)",
            }}
          >
            &#9733;
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Knowledge Base
        </h1>
        <button
          onClick={() => { setShowAsk(!showAsk); setAskResult(null); }}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          Ask a Question
        </button>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the knowledge base..."
          className="flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none"
          style={{
            background: "var(--wp-dark-surface)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
        />
        <button
          type="submit"
          className="px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        >
          Search
        </button>
      </form>

      {/* Ask a Question Panel */}
      {showAsk && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
            Ask a Question
          </h3>
          <form onSubmit={handleAsk} className="flex gap-2">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What would you like to know?"
              className="flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <button
              type="submit"
              disabled={asking}
              className="px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
            >
              {asking ? "Searching..." : "Ask"}
            </button>
          </form>

          {askResult && (
            <div className="mt-4">
              {askResult.answer ? (
                <div
                  className="rounded-lg border p-4"
                  style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        background: `${SOURCE_COLORS[askResult.source] || "var(--wp-text-dim)"}20`,
                        color: SOURCE_COLORS[askResult.source] || "var(--wp-text-dim)",
                      }}
                    >
                      {askResult.source}
                    </span>
                    <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      0 tokens used
                    </span>
                  </div>
                  <p className="text-sm">{askResult.answer.answer}</p>
                </div>
              ) : (
                <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                  No cached answer found. This question has been logged for the knowledge system to learn.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Entry List */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading...</p>
      ) : entries.length === 0 ? (
        <div
          className="rounded-lg border p-8 text-center"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <p style={{ color: "var(--wp-text-muted)" }}>No knowledge entries found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              onClick={() => setSelected(selected?.id === entry.id ? null : entry)}
              className="rounded-lg border p-4 cursor-pointer transition-colors hover:border-[var(--wp-gold)]"
              style={{
                background: selected?.id === entry.id ? "var(--wp-dark-surface2)" : "var(--wp-dark-surface)",
                borderColor: selected?.id === entry.id ? "var(--wp-gold)" : "var(--wp-dark-border)",
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{entry.question}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        background: `${SOURCE_COLORS[entry.source] || "var(--wp-text-dim)"}20`,
                        color: SOURCE_COLORS[entry.source] || "var(--wp-text-dim)",
                      }}
                    >
                      {entry.source}
                    </span>
                    <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                      {entry.view_count} views
                    </span>
                  </div>
                </div>
                {renderStars(entry)}
              </div>

              {/* Expanded */}
              {selected?.id === entry.id && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                  <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--wp-text-dim)" }}>
                    {entry.answer}
                  </p>
                  {entry.tags.length > 0 && (
                    <div className="flex gap-1.5 mt-3">
                      {entry.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-0.5 rounded"
                          style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
