"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import {
  queryKnowledgeWithCache,
  RagOfflineMissError,
} from "@/lib/knowledge-rag-offline";
import { saveKnowledgeEntryOffline } from "@/lib/knowledge-capture-offline";
import { RagSnapshotBadge } from "@/components/RagSnapshotBadge";

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

interface AskResult {
  answer: KnowledgeEntry | null;
  source: string;
  /** Set when the answer came from U1's offline RAG cache. */
  fromCache?: boolean;
  cachedAtMs?: number;
  isFuzzy?: boolean;
  similarity?: number;
  /** True when the server replied but has no cached answer for this question. */
  offlineMiss?: boolean;
}

function mkEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [showAsk, setShowAsk] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  // Capture panel state (add-new-entry path — routed through the
  // offline wrapper so field saves during flaky networks aren't lost).
  const [showCapture, setShowCapture] = useState(false);
  const [captureQuestion, setCaptureQuestion] = useState("");
  const [captureAnswer, setCaptureAnswer] = useState("");
  const [captureTags, setCaptureTags] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchEntries();
    fetchWithRefresh("/api/analytics", {
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

  async function handleAsk(e: FormEvent, forceRefresh = false) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setAskResult(null);
    try {
      const result = await queryKnowledgeWithCache(question, { forceRefresh });
      if (result.from_cache) {
        // Wrap the cached answer in a synthetic KnowledgeEntry so the
        // existing renderer shape stays the same.
        const synthetic: KnowledgeEntry = {
          id: result.sources[0]?.id ?? "cache",
          question,
          answer: result.answer,
          source: "cache",
          asked_by: "offline",
          confidence: result.similarity ?? 1,
          rating: null,
          view_count: 0,
          tokens_used: 0,
          tags: [],
          created_at: new Date(result.cached_at_ms ?? Date.now()).toISOString(),
        };
        setAskResult({
          answer: synthetic,
          source: "cache",
          fromCache: true,
          cachedAtMs: result.cached_at_ms,
          isFuzzy: result.is_fuzzy,
          similarity: result.similarity,
        });
      } else if (result.server_has_no_answer || !result.answer) {
        setAskResult({ answer: null, source: "none" });
      } else {
        // The server replied with a real answer; synthesize the full
        // entry from the wrapper's source list. The wrapper's primary
        // source carries id+title and the answer string.
        const entry: KnowledgeEntry = {
          id: result.sources[0]?.id ?? "server",
          question,
          answer: result.answer,
          source: result.source_kind ?? "docs",
          asked_by: "",
          confidence: 1,
          rating: null,
          view_count: 0,
          tokens_used: result.tokens_used ?? 0,
          tags: [],
          created_at: new Date().toISOString(),
        };
        setAskResult({ answer: entry, source: result.source_kind ?? "docs" });
      }
    } catch (err) {
      if (err instanceof RagOfflineMissError) {
        setAskResult({ answer: null, source: "offline", offlineMiss: true });
      } else {
        setAskResult({ answer: null, source: "error" });
      }
    }
    setAsking(false);
  }

  async function handleCapture(e: FormEvent) {
    e.preventDefault();
    const q = captureQuestion.trim();
    const a = captureAnswer.trim();
    if (!q || !a) {
      setCaptureMsg("Both question and answer are required");
      return;
    }
    setCapturing(true);
    setCaptureMsg("");
    try {
      const tags = captureTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const result = await saveKnowledgeEntryOffline({
        entry_id: mkEntryId(),
        question: q,
        answer: a,
        source: "human",
        tags,
        created_at: Date.now(),
      });
      if (result.status === "created") {
        setCaptureMsg("Saved");
        // Refresh list so the new entry shows up (online path only —
        // when queued, the entry is pending server-side and won't
        // appear in the list until replay).
        fetchEntries();
      } else {
        setCaptureMsg("Saved locally — will sync when online");
      }
      setCaptureQuestion("");
      setCaptureAnswer("");
      setCaptureTags("");
      setTimeout(() => setCaptureMsg(""), 3000);
    } catch (err) {
      setCaptureMsg((err as Error).message || "Failed to save");
    }
    setCapturing(false);
  }

  async function handleRate(entryId: string, rating: number) {
    // Optimistic UI
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, rating } : e))
    );
    if (selected?.id === entryId) setSelected({ ...selected, rating });

    // No dedicated rate endpoint yet, so just track it
    fetchWithRefresh("/api/analytics", {
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
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => { setShowAsk(!showAsk); setAskResult(null); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            Ask a Question
          </button>
          <button
            onClick={() => { setShowCapture(!showCapture); setCaptureMsg(""); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors border"
            style={{
              background: "var(--wp-dark-surface2)",
              borderColor: "var(--wp-dark-border)",
              color: "var(--wp-text)",
            }}
          >
            {showCapture ? "Close capture" : "Capture knowledge"}
          </button>
        </div>
      </div>

      {/* Capture Knowledge Panel — offline-first CREATE path */}
      {showCapture && (
        <div
          className="rounded-lg border p-5 space-y-3"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          data-testid="knowledge-capture-panel"
        >
          <h3 className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
            Capture a new knowledge entry
          </h3>
          <form onSubmit={handleCapture} className="space-y-3">
            <input
              type="text"
              value={captureQuestion}
              onChange={(e) => setCaptureQuestion(e.target.value)}
              placeholder="Question (e.g. How do I rotate a JWT refresh token?)"
              className="w-full rounded-lg border px-4 py-2 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <textarea
              value={captureAnswer}
              onChange={(e) => setCaptureAnswer(e.target.value)}
              placeholder="Answer (markdown ok)"
              rows={4}
              className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <input
              type="text"
              value={captureTags}
              onChange={(e) => setCaptureTags(e.target.value)}
              placeholder="Tags, comma-separated (optional)"
              className="w-full rounded-lg border px-4 py-2 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={capturing}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                {capturing ? "Saving..." : "Save entry"}
              </button>
              {captureMsg && (
                <span
                  className="text-sm"
                  style={{
                    color: captureMsg.startsWith("Saved")
                      ? "var(--wp-success)"
                      : "var(--wp-error)",
                  }}
                  data-testid="knowledge-capture-msg"
                >
                  {captureMsg}
                </span>
              )}
            </div>
          </form>
        </div>
      )}

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
            <div className="mt-4" data-testid="knowledge-ask-result">
              {askResult.answer ? (
                <div
                  className="rounded-lg border p-4"
                  style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
                >
                  {askResult.fromCache && askResult.cachedAtMs && (
                    <div className="mb-2" data-testid="knowledge-snapshot-badge">
                      <RagSnapshotBadge
                        cachedAtMs={askResult.cachedAtMs}
                        isFuzzy={!!askResult.isFuzzy}
                        similarity={askResult.similarity}
                        isOnline={isOnline}
                        onRefresh={
                          isOnline
                            ? () => {
                                void handleAsk(
                                  { preventDefault: () => undefined } as FormEvent,
                                  true,
                                );
                              }
                            : undefined
                        }
                      />
                    </div>
                  )}
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
              ) : askResult.offlineMiss ? (
                <p
                  className="text-sm"
                  style={{ color: "var(--wp-text-muted)" }}
                  data-testid="knowledge-offline-miss"
                >
                  You&apos;re offline and this question hasn&apos;t been asked before.
                  Connect and ask to cache it.
                </p>
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
