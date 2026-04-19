"use client";

/**
 * CommentsPane — designer-facing side panel of per-section review
 * comments. Path C Phase 3 · Stream R3.
 *
 * Responsibilities:
 *   - Fetches comments for `siteId` from /api/sites/[id]/comments via
 *     fetchWithRefresh (authed path — never raw fetch per CLAUDE.md).
 *   - Groups comments by (pageIndex, sectionIndex). Replies nested
 *     under their parent, one level deep (we don't need 3-deep
 *     threads for a review flow — keeps the UI readable).
 *   - Filter tabs: open / resolved / all. Default "open" because the
 *     hot path is "what still needs my attention?"
 *   - Click a comment → postMessage `comment.focus` to the preview
 *     iframe so the designer sees which section it targets.
 *   - Resolve button per top-level comment (recursive on the server;
 *     the whole thread flips at once). Optimistic UI: the local state
 *     flips to resolved immediately; a failure reverts + surfaces an
 *     error.
 *   - Reply composer per comment (POST with parent_comment_id).
 *   - Soft delete per comment via the trash button.
 *
 * Uses <details> for the shell so the pane collapses like the rest of
 * the sites/[id]/edit page (consistent with ThemeEditor, SharePanel,
 * etc.).
 *
 * Analytics: the ROUTE fires comment_resolved / comment_replied /
 * comment_deleted on success — this component does NOT emit its own
 * events (avoids double-counting).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import {
  INSTINCT_EDIT_ORIGIN,
  type InlineEditMessage,
} from "@/lib/preview-postmessage";

type Filter = "open" | "resolved" | "all";

export interface CommentView {
  id: string;
  siteId: string;
  shareTokenId: string | null;
  pageIndex: number;
  sectionIndex: number;
  sectionType: string | null;
  body: string;
  actorName: string | null;
  actorEmail: string | null;
  parentCommentId: string | null;
  state: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface Props {
  siteId: string;
  /** Optional ref to the preview iframe; used to target comment.focus
   *  postMessages. If absent, the click-to-focus becomes a no-op. */
  previewIframeRef?: React.RefObject<HTMLIFrameElement | null>;
}

export default function CommentsPane({ siteId, previewIframeRef }: Props) {
  const [comments, setComments] = useState<CommentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("open");
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/sites/${encodeURIComponent(siteId)}/comments?filter=all`,
      );
      if (!res.ok) {
        setError(`Failed to load comments (${res.status})`);
        return;
      }
      const data = (await res.json()) as { comments: CommentView[] };
      setComments(data.comments ?? []);
    } catch (err) {
      setError((err as Error).message || "Network error.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  // --- derived view: filter + group ----------------------------------
  const { groups, topLevelCount } = useMemo(() => {
    const filtered = comments.filter((c) => {
      if (filter === "open") return c.state === "open";
      if (filter === "resolved") return c.state === "resolved";
      return true;
    });
    const byParent = new Map<string, CommentView[]>();
    const topLevel: CommentView[] = [];
    for (const c of filtered) {
      if (c.parentCommentId) {
        const arr = byParent.get(c.parentCommentId) ?? [];
        arr.push(c);
        byParent.set(c.parentCommentId, arr);
      } else {
        topLevel.push(c);
      }
    }
    // Group top-level by (pageIndex, sectionIndex) for the section
    // header rows. Sections ordered by page then section index.
    const grouping = new Map<string, CommentView[]>();
    for (const c of topLevel) {
      const key = `${c.pageIndex}:${c.sectionIndex}`;
      const arr = grouping.get(key) ?? [];
      arr.push(c);
      grouping.set(key, arr);
    }
    const groups = Array.from(grouping.entries())
      .map(([key, arr]) => {
        const [p, s] = key.split(":").map(Number);
        const repliesFor = (id: string) => byParent.get(id) ?? [];
        return { pageIndex: p, sectionIndex: s, comments: arr, repliesFor };
      })
      .sort((a, b) =>
        a.pageIndex !== b.pageIndex
          ? a.pageIndex - b.pageIndex
          : a.sectionIndex - b.sectionIndex,
      );
    return { groups, topLevelCount: topLevel.length };
  }, [comments, filter]);

  // --- iframe postMessage (comment.focus) ----------------------------
  function focusSection(pageIndex: number, sectionIndex: number) {
    const iframe = previewIframeRef?.current;
    if (!iframe || !iframe.contentWindow) return;
    const msg: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "comment.focus",
      pageIndex,
      sectionIndex,
    };
    iframe.contentWindow.postMessage(msg, window.location.origin);
  }

  async function handleResolve(commentId: string) {
    // Optimistic update: flip this + any children locally.
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId || c.parentCommentId === commentId
          ? { ...c, state: "resolved" as const }
          : c,
      ),
    );
    try {
      const res = await fetchWithRefresh(
        `/api/sites/${encodeURIComponent(siteId)}/comments/${encodeURIComponent(commentId)}/resolve`,
        { method: "POST" },
      );
      if (!res.ok) {
        // Revert on failure.
        setError(`Failed to resolve comment (${res.status})`);
        load();
      }
    } catch (err) {
      setError((err as Error).message || "Network error.");
      load();
    }
  }

  async function handleDelete(commentId: string) {
    if (!window.confirm("Delete this comment? The row is preserved but the body is tombstoned.")) {
      return;
    }
    try {
      const res = await fetchWithRefresh(
        `/api/sites/${encodeURIComponent(siteId)}/comments/${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError(`Failed to delete comment (${res.status})`);
        return;
      }
      await load();
    } catch (err) {
      setError((err as Error).message || "Network error.");
    }
  }

  async function handleReplySubmit(parent: CommentView) {
    const body = replyBody.trim();
    if (!body) return;
    try {
      const res = await fetchWithRefresh(
        `/api/sites/${encodeURIComponent(siteId)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pageIndex: parent.pageIndex,
            sectionIndex: parent.sectionIndex,
            sectionType: parent.sectionType ?? undefined,
            body,
            parentCommentId: parent.id,
          }),
        },
      );
      if (!res.ok) {
        setError(`Failed to post reply (${res.status})`);
        return;
      }
      setReplyTo(null);
      setReplyBody("");
      await load();
    } catch (err) {
      setError((err as Error).message || "Network error.");
    }
  }

  return (
    <details data-testid="comments-pane" open style={{ marginTop: 16 }}>
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 14,
          padding: "8px 0",
        }}
      >
        Client comments
        {!loading && (
          <span
            data-testid="comments-pane-count"
            style={{ marginLeft: 8, color: "var(--wp-text-dim, #888)" }}
          >
            ({topLevelCount})
          </span>
        )}
      </summary>

      <div style={{ paddingTop: 8 }}>
        <div
          role="tablist"
          aria-label="Comment filter"
          style={{ display: "flex", gap: 4, marginBottom: 12 }}
        >
          {(["open", "resolved", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              data-testid={`comments-filter-${f}`}
              onClick={() => setFilter(f)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                background: filter === f ? "#333" : "transparent",
                color: filter === f ? "#fff" : "#aaa",
                border: "1px solid #333",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {error && (
          <div
            data-testid="comments-pane-error"
            role="alert"
            style={{ fontSize: 12, color: "#ff9e9e", marginBottom: 8 }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div data-testid="comments-pane-loading" style={{ fontSize: 12, color: "#888" }}>
            Loading comments…
          </div>
        ) : groups.length === 0 ? (
          <div
            data-testid="comments-pane-empty"
            style={{ fontSize: 13, color: "#888", padding: "20px 0" }}
          >
            No {filter === "all" ? "" : filter + " "}comments yet.
          </div>
        ) : (
          <ul
            data-testid="comments-pane-list"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {groups.map((group) => (
              <li
                key={`${group.pageIndex}:${group.sectionIndex}`}
                data-testid={`comments-group-${group.pageIndex}-${group.sectionIndex}`}
                style={{ marginBottom: 16 }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: "#888",
                    textTransform: "uppercase",
                    marginBottom: 4,
                    letterSpacing: "0.05em",
                  }}
                >
                  Page {group.pageIndex + 1} · Section {group.sectionIndex + 1}
                </div>
                {group.comments.map((c) => (
                  <div
                    key={c.id}
                    data-testid={`comment-${c.id}`}
                    style={{
                      padding: 8,
                      background: c.state === "resolved" ? "#181818" : "#1a1a1a",
                      border: `1px solid ${c.state === "resolved" ? "#2a4a35" : "#333"}`,
                      borderRadius: 4,
                      marginBottom: 6,
                      opacity: c.state === "resolved" ? 0.65 : 1,
                    }}
                  >
                    <button
                      type="button"
                      data-testid={`comment-focus-${c.id}`}
                      onClick={() => focusSection(c.pageIndex, c.sectionIndex)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        textAlign: "left",
                        width: "100%",
                      }}
                    >
                      <div style={{ fontSize: 13, marginBottom: 4 }}>{c.body}</div>
                      <div style={{ fontSize: 11, color: "#888" }}>
                        {c.actorName || "anonymous"}
                        {c.actorEmail ? ` · ${c.actorEmail}` : ""}
                      </div>
                    </button>
                    {/* replies */}
                    {group.repliesFor(c.id).length > 0 && (
                      <ul
                        data-testid={`comment-replies-${c.id}`}
                        style={{
                          listStyle: "none",
                          padding: 0,
                          margin: "8px 0 0 16px",
                          borderLeft: "2px solid #333",
                          paddingLeft: 8,
                        }}
                      >
                        {group.repliesFor(c.id).map((r) => (
                          <li
                            key={r.id}
                            data-testid={`comment-reply-${r.id}`}
                            style={{ fontSize: 12, color: "#ccc", marginBottom: 4 }}
                          >
                            <div>{r.body}</div>
                            <div style={{ fontSize: 10, color: "#666" }}>
                              {r.actorName || "anonymous"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div
                      style={{
                        display: "flex",
                        gap: 4,
                        marginTop: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      {c.state === "open" && (
                        <button
                          type="button"
                          data-testid={`comment-resolve-${c.id}`}
                          onClick={() => handleResolve(c.id)}
                          style={smallBtn}
                        >
                          Resolve
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid={`comment-reply-btn-${c.id}`}
                        onClick={() => {
                          setReplyTo(c.id);
                          setReplyBody("");
                        }}
                        style={smallBtn}
                      >
                        Reply
                      </button>
                      <button
                        type="button"
                        data-testid={`comment-delete-${c.id}`}
                        onClick={() => handleDelete(c.id)}
                        style={smallBtn}
                      >
                        Delete
                      </button>
                    </div>
                    {replyTo === c.id && (
                      <div style={{ marginTop: 8 }} data-testid={`comment-reply-form-${c.id}`}>
                        <textarea
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          rows={2}
                          placeholder="Reply…"
                          data-testid={`comment-reply-input-${c.id}`}
                          style={{
                            width: "100%",
                            background: "#0a0a0a",
                            color: "#fff",
                            border: "1px solid #333",
                            borderRadius: 4,
                            padding: 6,
                            fontSize: 12,
                            fontFamily: "inherit",
                          }}
                        />
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            marginTop: 4,
                            justifyContent: "flex-end",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTo(null);
                              setReplyBody("");
                            }}
                            style={smallBtn}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            data-testid={`comment-reply-submit-${c.id}`}
                            onClick={() => handleReplySubmit(c)}
                            style={{ ...smallBtn, background: "#2e7d4f", color: "#fff" }}
                          >
                            Post reply
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

const smallBtn: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 11,
  background: "transparent",
  color: "#ccc",
  border: "1px solid #333",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
};
