"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders } from "@/lib/client-auth";

interface Discussion {
  id: string;
  title: string;
  category: string;
  created_by: string;
  status: string;
  pinned: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
  reply_count?: number;
}

interface Reply {
  id: string;
  discussion_id: string;
  author_id: string;
  content: string;
  created_at: string;
  author_name?: string;
  author_role?: string;
}

interface ThreadDetail {
  discussion: Discussion;
  replies: Reply[];
}

const CATEGORY_COLORS: Record<string, string> = {
  product: "var(--wp-gold)",
  client: "var(--wp-info)",
  engineering: "var(--wp-success)",
  process: "var(--wp-warning)",
  general: "var(--wp-text-dim)",
};

const CATEGORIES = ["product", "client", "engineering", "process", "general"];

export default function DiscussionsPage() {
  const [threads, setThreads] = useState<Discussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selectedThread, setSelectedThread] = useState<ThreadDetail | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  // New thread form
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [newContent, setNewContent] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  // Reply form
  const [replyContent, setReplyContent] = useState("");
  const [replying, setReplying] = useState(false);

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchThreads();
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "discussions" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchThreads() {
    setLoading(true);
    try {
      const res = await fetch("/api/discussions");
      const data = await res.json();
      setThreads(data.threads || []);
    } catch {
      setThreads([]);
    }
    setLoading(false);
  }

  async function openThread(threadId: string) {
    setLoadingThread(true);
    try {
      const res = await fetch(`/api/discussions/${threadId}`);
      const data = await res.json();
      setSelectedThread(data);
    } catch {
      setSelectedThread(null);
    }
    setLoadingThread(false);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateMsg("");
    try {
      const res = await fetch("/api/discussions", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          title: newTitle,
          category: newCategory,
          content: newContent,
        }),
      });
      if (res.ok) {
        setCreateMsg("Discussion created!");
        setNewTitle("");
        setNewContent("");
        setNewCategory("general");
        setShowNew(false);
        fetchThreads();
      } else {
        const data = await res.json();
        setCreateMsg(data.error || "Failed to create");
      }
    } catch {
      setCreateMsg("Failed to create");
    }
    setCreating(false);
  }

  async function handleReply(e: FormEvent) {
    e.preventDefault();
    if (!selectedThread || !replyContent.trim()) return;
    setReplying(true);
    try {
      const res = await fetch(`/api/discussions/${selectedThread.discussion.id}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: replyContent }),
      });
      if (res.ok) {
        setReplyContent("");
        openThread(selectedThread.discussion.id);
        fetchThreads();
      }
    } catch {
      // silent
    }
    setReplying(false);
  }

  // Thread detail view
  if (selectedThread) {
    const d = selectedThread.discussion;
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <button
          onClick={() => setSelectedThread(null)}
          className="flex items-center gap-1 text-sm transition-colors"
          style={{ color: "var(--wp-gold)" }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Discussions
        </button>

        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <div className="flex items-start justify-between gap-4 mb-3">
            <h1 className="text-xl font-bold">{d.title}</h1>
            <div className="flex items-center gap-2">
              {d.pinned && (
                <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ background: "var(--wp-gold)20", color: "var(--wp-gold)" }}>
                  Pinned
                </span>
              )}
              <span
                className="text-xs px-2 py-0.5 rounded font-medium"
                style={{
                  background: `${CATEGORY_COLORS[d.category] || "var(--wp-text-dim)"}20`,
                  color: CATEGORY_COLORS[d.category] || "var(--wp-text-dim)",
                }}
              >
                {d.category}
              </span>
            </div>
          </div>
          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            By {d.created_by} on {new Date(d.created_at).toLocaleDateString()} -- {d.status}
          </p>
        </div>

        {/* Replies */}
        <div className="space-y-3">
          {selectedThread.replies.map((r) => (
            <div
              key={r.id}
              className="rounded-lg border p-4"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium" style={{ color: "var(--wp-gold)" }}>
                  {r.author_name || r.author_id}
                </span>
                {r.author_role && (
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}>
                    {r.author_role}
                  </span>
                )}
                <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                  {new Date(r.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{r.content}</p>
            </div>
          ))}
        </div>

        {/* Reply form */}
        <form
          onSubmit={handleReply}
          className="rounded-lg border p-4"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <textarea
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            placeholder="Write a reply..."
            rows={3}
            required
            className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-none mb-3"
            style={{
              background: "var(--wp-dark-surface2)",
              borderColor: "var(--wp-dark-border)",
              color: "var(--wp-text)",
            }}
          />
          <button
            type="submit"
            disabled={replying}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            {replying ? "Posting..." : "Post Reply"}
          </button>
        </form>
      </div>
    );
  }

  // Thread list view
  const pinned = threads.filter((t) => t.pinned);
  const unpinned = threads.filter((t) => !t.pinned);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Discussions
        </h1>
        <button
          onClick={() => setShowNew(!showNew)}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          New Discussion
        </button>
      </div>

      {createMsg && (
        <div
          className="rounded-lg px-4 py-2.5 text-sm"
          style={{
            background: createMsg.includes("created") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            color: createMsg.includes("created") ? "var(--wp-success)" : "var(--wp-error)",
          }}
        >
          {createMsg}
        </div>
      )}

      {/* New Thread Form */}
      {showNew && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            New Discussion
          </h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Discussion title"
              required
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Start the discussion..."
              required
              rows={4}
              className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                {creating ? "Creating..." : "Create Discussion"}
              </button>
              <button
                type="button"
                onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ color: "var(--wp-text-dim)" }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Thread List */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading discussions...</p>
      ) : threads.length === 0 ? (
        <div
          className="rounded-lg border p-8 text-center"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <p style={{ color: "var(--wp-text-muted)" }}>No discussions yet. Start one!</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Pinned */}
          {pinned.map((t) => renderThread(t, true))}
          {/* Regular */}
          {unpinned.map((t) => renderThread(t, false))}
        </div>
      )}

      {loadingThread && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading thread...</p>
        </div>
      )}
    </div>
  );

  function renderThread(t: Discussion, isPinned: boolean) {
    return (
      <div
        key={t.id}
        onClick={() => openThread(t.id)}
        className="rounded-lg border p-4 cursor-pointer transition-colors hover:border-[var(--wp-gold)]"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isPinned && (
                <span className="text-xs" style={{ color: "var(--wp-gold)" }}>
                  Pinned
                </span>
              )}
              <p className="text-sm font-medium">{t.title}</p>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className="text-xs px-2 py-0.5 rounded font-medium"
                style={{
                  background: `${CATEGORY_COLORS[t.category] || "var(--wp-text-dim)"}20`,
                  color: CATEGORY_COLORS[t.category] || "var(--wp-text-dim)",
                }}
              >
                {t.category}
              </span>
              <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                {t.reply_count || 0} replies
              </span>
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: t.status === "resolved" ? "var(--wp-success)20" : "var(--wp-info)20",
                  color: t.status === "resolved" ? "var(--wp-success)" : "var(--wp-info)",
                }}
              >
                {t.status}
              </span>
            </div>
          </div>
          <span className="text-xs whitespace-nowrap" style={{ color: "var(--wp-text-muted)" }}>
            {new Date(t.updated_at).toLocaleDateString()}
          </span>
        </div>
      </div>
    );
  }
}
