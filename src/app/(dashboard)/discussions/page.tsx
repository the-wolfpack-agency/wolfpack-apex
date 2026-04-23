"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import {
  sendDiscussionThreadOffline,
  sendDiscussionReplyOffline,
} from "@/lib/discussions-offline";
import ConfirmDialog from "@/components/ConfirmDialog";

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
  const [notifyAll, setNotifyAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  // Confirm-delete modal. `kind=thread` targets the currently open thread,
  // `kind=reply` stores the reply id so the handler knows which row to delete.
  // Keeping state as a single object + null keeps only one dialog open at a
  // time and avoids the "two confirmations" bug we've hit on other pages.
  const [confirmTarget, setConfirmTarget] = useState<
    | { kind: "thread" }
    | { kind: "reply"; replyId: string }
    | null
  >(null);

  // Transient toast for optimistic-delete rollback. `key` is just a
  // monotonic tag so repeated same-text toasts re-render.
  const [toast, setToast] = useState<{ key: number; text: string } | null>(
    null,
  );
  function showToast(text: string) {
    setToast({ key: Date.now(), text });
    setTimeout(() => setToast(null), 4000);
  }

  // Reply form
  const [replyContent, setReplyContent] = useState("");
  const [replying, setReplying] = useState(false);

  // Edit / delete state for the thread itself and for individual replies.
  // Keyed by id so only one editor opens at a time. Routed through
  // fetchWithRefresh to avoid the April 16 raw-fetch blank-dashboard bug.
  const [editingThread, setEditingThread] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const [threadCategory, setThreadCategory] = useState("general");
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editReplyContent, setEditReplyContent] = useState("");
  const [editMsg, setEditMsg] = useState("");

  async function saveThreadEdit(e: FormEvent) {
    e.preventDefault();
    if (!selectedThread) return;
    setEditMsg("");
    try {
      const r = await fetchWithRefresh(
        `/api/discussions/${selectedThread.discussion.id}`,
        {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ title: threadTitle, category: threadCategory }),
        },
      );
      if (r.ok) {
        setEditMsg("Saved");
        setEditingThread(false);
        openThread(selectedThread.discussion.id);
        fetchThreads();
      } else {
        const data = await r.json().catch(() => ({}));
        setEditMsg(data.error ?? "Save failed");
      }
    } catch {
      setEditMsg("Save failed");
    }
  }

  function requestDeleteThread() {
    if (!selectedThread) return;
    setConfirmTarget({ kind: "thread" });
  }

  async function deleteThread() {
    if (!selectedThread) return;
    const thread = selectedThread;
    const threadId = thread.discussion.id;

    // Optimistic: close the detail view + drop the row from the list
    // immediately. On failure we restore both so the user doesn't see a
    // silent revert on next refresh.
    const previousThreads = threads;
    setThreads((prev) => prev.filter((d) => d.id !== threadId));
    setSelectedThread(null);

    try {
      const r = await fetchWithRefresh(
        `/api/discussions/${threadId}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        // Roll back
        setThreads(previousThreads);
        setSelectedThread(thread);
        showToast("Failed to delete discussion. Restored.");
        return;
      }
      // Success — sync with server just in case another writer reshuffled
      // pinned ordering while we were deleting.
      fetchThreads();
    } catch {
      setThreads(previousThreads);
      setSelectedThread(thread);
      showToast("Failed to delete discussion. Restored.");
    }
  }

  function startEditReply(reply: Reply) {
    setEditingReplyId(reply.id);
    setEditReplyContent(reply.content);
    setEditMsg("");
  }

  function cancelReplyEdit() {
    setEditingReplyId(null);
    setEditReplyContent("");
    setEditMsg("");
  }

  async function saveReplyEdit(e: FormEvent, replyId: string) {
    e.preventDefault();
    if (!selectedThread) return;
    if (!editReplyContent.trim()) {
      setEditMsg("Content required");
      return;
    }
    try {
      const r = await fetchWithRefresh(
        `/api/discussions/${selectedThread.discussion.id}/comments/${replyId}`,
        {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ content: editReplyContent }),
        },
      );
      if (r.ok) {
        cancelReplyEdit();
        openThread(selectedThread.discussion.id);
      } else {
        const data = await r.json().catch(() => ({}));
        setEditMsg(data.error ?? "Save failed");
      }
    } catch {
      setEditMsg("Save failed");
    }
  }

  function requestDeleteReply(replyId: string) {
    if (!selectedThread) return;
    setConfirmTarget({ kind: "reply", replyId });
  }

  async function deleteReply(replyId: string) {
    if (!selectedThread) return;
    const discussionId = selectedThread.discussion.id;

    // Optimistic: yank the reply row from the currently-open detail view
    // so it disappears immediately. On failure we splice it back in at the
    // same index and surface a toast.
    const previousReplies = selectedThread.replies;
    const removedIndex = previousReplies.findIndex((r) => r.id === replyId);
    if (removedIndex < 0) return;
    const removed = previousReplies[removedIndex];

    setSelectedThread({
      ...selectedThread,
      replies: previousReplies.filter((r) => r.id !== replyId),
    });

    try {
      const r = await fetchWithRefresh(
        `/api/discussions/${discussionId}/comments/${replyId}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const restored = [...previousReplies];
        restored.splice(removedIndex, 0, removed);
        setSelectedThread((cur) =>
          cur && cur.discussion.id === discussionId
            ? { ...cur, replies: restored }
            : cur,
        );
        showToast("Failed to delete comment. Restored.");
      }
    } catch {
      const restored = [...previousReplies];
      restored.splice(removedIndex, 0, removed);
      setSelectedThread((cur) =>
        cur && cur.discussion.id === discussionId
          ? { ...cur, replies: restored }
          : cur,
      );
      showToast("Failed to delete comment. Restored.");
    }
  }

  async function handleConfirm() {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (!target) return;
    if (target.kind === "thread") {
      await deleteThread();
    } else {
      await deleteReply(target.replyId);
    }
  }

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchThreads();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "discussions" } }),
    }).catch(() => {});
     
  }, []);

  async function fetchThreads() {
    setLoading(true);
    try {
      const res = await fetchWithRefresh("/api/discussions");
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
      const res = await fetchWithRefresh(`/api/discussions/${threadId}`);
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
      if (notifyAll) {
        // notify_all triggers a server-side team-wide fanout. We skip the
        // offline-queue wrapper here because the queue body type doesn't
        // carry the flag and a queued-then-replayed notify-all could fire
        // stale notifications long after the fact. Users who really want
        // that behavior can uncheck the box and resubmit online.
        const r = await fetchWithRefresh("/api/discussions", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            title: newTitle,
            category: newCategory,
            content: newContent,
            notify_all: true,
          }),
        });
        if (r.ok) {
          setCreateMsg("Discussion created!");
        } else {
          setCreateMsg("Failed to create");
        }
      } else {
        // Route through the offline-aware wrapper so a network blip queues
        // the write for replay instead of dropping it on the floor.
        const result = await sendDiscussionThreadOffline({
          title: newTitle,
          category: newCategory,
          content: newContent,
        });
        if (result.status === "sent") {
          setCreateMsg("Discussion created!");
        } else {
          setCreateMsg("Offline — will send when online");
        }
      }
      setNewTitle("");
      setNewContent("");
      setNewCategory("general");
      setNotifyAll(false);
      setShowNew(false);
      fetchThreads();
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
      const result = await sendDiscussionReplyOffline({
        thread_id: selectedThread.discussion.id,
        content: replyContent,
      });
      setReplyContent("");
      if (result.status === "sent") {
        openThread(selectedThread.discussion.id);
        fetchThreads();
      }
      // When queued we don't refresh the thread (the reply isn't on the
      // server yet). The OfflineStatusPill surfaces the pending count;
      // flush-on-online will replay the reply and the next open will
      // show it.
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
          {editingThread ? (
            <form
              onSubmit={saveThreadEdit}
              className="space-y-3"
              data-testid="thread-edit-form"
            >
              <input
                type="text"
                value={threadTitle}
                onChange={(e) => setThreadTitle(e.target.value)}
                placeholder="Title"
                aria-label="Edit thread title"
                required
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
              <select
                value={threadCategory}
                onChange={(e) => setThreadCategory(e.target.value)}
                aria-label="Edit thread category"
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
              <div className="flex gap-2 items-center">
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg text-sm font-semibold"
                  style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingThread(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ color: "var(--wp-text-dim)" }}
                >
                  Cancel
                </button>
                {editMsg && (
                  <span
                    className="text-sm"
                    data-testid="thread-edit-msg"
                    style={{
                      color:
                        editMsg === "Saved" ? "var(--wp-success)" : "var(--wp-error)",
                    }}
                  >
                    {editMsg}
                  </span>
                )}
              </div>
            </form>
          ) : (
            <>
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
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingThread(true);
                    setThreadTitle(d.title);
                    setThreadCategory(d.category);
                  }}
                  aria-label="Edit thread"
                  data-testid="thread-edit-btn"
                  className="text-xs px-2 py-1 rounded border"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={requestDeleteThread}
                  aria-label="Delete thread"
                  data-testid="thread-delete-btn"
                  className="text-xs px-2 py-1 rounded border"
                  style={{
                    background: "var(--wp-dark-surface2)",
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-error)",
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>

        {/* Replies */}
        <div className="space-y-3">
          {selectedThread.replies.map((r) => (
            <div
              key={r.id}
              data-testid={`reply-${r.id}`}
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
                <div className="ml-auto flex gap-1">
                  <button
                    type="button"
                    onClick={() => startEditReply(r)}
                    aria-label={`Edit comment ${r.id}`}
                    data-testid={`reply-edit-btn-${r.id}`}
                    className="text-xs px-2 py-0.5 rounded border"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      borderColor: "var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDeleteReply(r.id)}
                    aria-label={`Delete comment ${r.id}`}
                    data-testid={`reply-delete-btn-${r.id}`}
                    className="text-xs px-2 py-0.5 rounded border"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      borderColor: "var(--wp-dark-border)",
                      color: "var(--wp-error)",
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {editingReplyId === r.id ? (
                <form
                  onSubmit={(e) => saveReplyEdit(e, r.id)}
                  className="space-y-2"
                  data-testid={`reply-edit-form-${r.id}`}
                >
                  <textarea
                    value={editReplyContent}
                    onChange={(e) => setEditReplyContent(e.target.value)}
                    aria-label="Edit comment content"
                    rows={3}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none"
                    style={{
                      background: "var(--wp-dark-surface2)",
                      borderColor: "var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  />
                  <div className="flex gap-2 items-center">
                    <button
                      type="submit"
                      className="px-3 py-1 rounded text-xs font-semibold"
                      style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelReplyEdit}
                      className="px-3 py-1 rounded text-xs"
                      style={{ color: "var(--wp-text-dim)" }}
                    >
                      Cancel
                    </button>
                    {editMsg && (
                      <span className="text-xs" style={{ color: "var(--wp-error)" }}>
                        {editMsg}
                      </span>
                    )}
                  </div>
                </form>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{r.content}</p>
              )}
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
        {renderOverlays()}
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
            <label
              className="flex items-center gap-2 text-sm select-none cursor-pointer"
              style={{ color: "var(--wp-text-dim)" }}
            >
              <input
                type="checkbox"
                checked={notifyAll}
                onChange={(e) => setNotifyAll(e.target.checked)}
                aria-label="Notify all Wolfpack team members"
                data-testid="notify-all-checkbox"
              />
              Notify all Wolfpack team members
            </label>
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
      {renderOverlays()}
    </div>
  );

  function renderOverlays() {
    return (
      <>
        <ConfirmDialog
          open={confirmTarget !== null}
          destructive
          title={
            confirmTarget?.kind === "thread"
              ? "Delete discussion?"
              : "Delete comment?"
          }
          body={
            confirmTarget?.kind === "thread"
              ? `This will permanently remove "${selectedThread?.discussion.title ?? ""}" and all of its replies.`
              : "This comment will be permanently removed."
          }
          confirmLabel="Delete"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmTarget(null)}
        />
        {toast && (
          <div
            key={toast.key}
            role="status"
            data-testid="discussions-toast"
            className="fixed bottom-6 right-6 z-[90] rounded-lg px-4 py-2 text-sm shadow-lg"
            style={{
              background: "var(--wp-error)",
              color: "#fff",
            }}
          >
            {toast.text}
          </div>
        )}
      </>
    );
  }

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
