"use client";

/**
 * /admin/feedback — CTO/CEO view of recent /feedback submissions.
 * Inbox-style: Open vs Resolved tabs, one-click resolve/reopen,
 * optional resolution note. Auto-refreshes are user-triggered.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface FeedbackRow {
  id: string;
  user_id: string;
  user_email: string | null;
  user_role: string | null;
  message: string;
  surface: string | null;
  user_agent: string | null;
  workflow_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  /* Dedup metadata from the inbox collapse. times_filed > 1 means the
     same note was submitted more than once; created_at is the EARLIEST
     (original) date and last_filed_at the most recent. Optional so an
     older API/build that omits them still renders. */
  times_filed?: number;
  last_filed_at?: string | null;
}

interface FeedbackResponse {
  workspace_id: string;
  count: number;
  limit: number;
  status: string;
  feedback: FeedbackRow[];
}

type StatusFilter = "open" | "resolved" | "all";

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/* Absolute short date ("May 1, 2026") for the "first on <date>" line so an
   old note that was re-filed recently reads as old, not fresh. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function FeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [busyId, setBusyId] = useState<string | null>(null);
  /* Which row is currently composing a resolution note. Only one note
     textarea is open at a time so the page stays focused. */
  const [composingNoteFor, setComposingNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/feedback?limit=200&status=${filter}`);
      if (!res.ok) {
        if (res.status === 403) setError("You don't have permission to view team feedback.");
        else setError(`Could not load feedback (HTTP ${res.status}).`);
        setRows([]);
        return;
      }
      const body = (await res.json()) as FeedbackResponse;
      setRows(body.feedback ?? []);
    } catch (e) {
      setError((e as Error).message || "Network error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleResolved(row: FeedbackRow, note?: string) {
    const action = row.resolved_at ? "reopen" : "resolve";
    setBusyId(row.id);
    try {
      const res = await fetchWithRefresh(`/api/admin/feedback/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          /* note is only sent on resolve; reopen never carries one (the
             API ignores it anyway, but no point sending). */
          ...(action === "resolve" && note && note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error || `Could not ${action} (HTTP ${res.status})`);
        return;
      }
      setComposingNoteFor(null);
      setNoteDraft("");
      await load();
    } finally {
      setBusyId(null);
    }
  }

  function startComposing(rowId: string) {
    setComposingNoteFor(rowId);
    setNoteDraft("");
  }

  function cancelComposing() {
    setComposingNoteFor(null);
    setNoteDraft("");
  }

  return (
    <div
      data-testid="admin-feedback-page"
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "920px",
        margin: "0 auto",
        color: "var(--wp-text, #eee)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>
          Team feedback
        </h1>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            background: "var(--wp-dark-surface2, #1a1a1a)",
            color: "var(--wp-text-dim, #aaa)",
            border: "1px solid var(--wp-dark-border, #333)",
            borderRadius: "6px",
            padding: "0.4rem 0.9rem",
            fontSize: "0.85rem",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0 0 1rem 0", fontSize: "0.9rem" }}>
        Every note submitted via <code>/feedback</code>. Mark resolved when addressed.
      </p>

      <div data-testid="admin-feedback-filter" style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem" }}>
        {(["open", "resolved", "all"] as StatusFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            data-testid={`admin-feedback-filter-${f}`}
            style={{
              padding: "0.35rem 0.9rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              cursor: "pointer",
              background: filter === f ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-surface, #1f1f22)",
              color: filter === f ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
              border: `1px solid ${filter === f ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
              textTransform: "capitalize",
              fontWeight: filter === f ? 600 : 400,
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {error && (
        <div
          data-testid="admin-feedback-error"
          style={{
            padding: "0.75rem 1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <div
          data-testid="admin-feedback-empty"
          style={{
            padding: "1.5rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px dashed var(--wp-dark-border, #333)",
            borderRadius: "8px",
            textAlign: "center",
            color: "var(--wp-text-muted, #6b7280)",
          }}
        >
          {filter === "open"
            ? "Nothing open. Switch to All to see resolved entries."
            : filter === "resolved"
            ? "No resolved feedback yet."
            : "No feedback yet."}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="admin-feedback-list">
        {rows.map((r) => {
          const isResolved = Boolean(r.resolved_at);
          return (
            <li
              key={r.id}
              data-testid={`admin-feedback-row-${r.id}`}
              style={{
                padding: "1rem 1.1rem",
                marginBottom: "0.5rem",
                background: "var(--wp-dark-surface, #1f1f22)",
                border: `1px solid ${isResolved ? "var(--wp-dark-border, #333)" : "var(--wp-gold, #f1c233)"}`,
                borderRadius: "8px",
                opacity: isResolved ? 0.7 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
                <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
                  <strong style={{ color: "var(--wp-text, #eee)" }}>{r.user_email ?? r.user_id}</strong>
                  {r.user_role && <span style={{ marginLeft: "0.5rem", color: "var(--wp-text-muted, #6b7280)" }}>· {r.user_role}</span>}
                  {r.surface && <span style={{ marginLeft: "0.5rem", color: "var(--wp-text-muted, #6b7280)" }}>· from {r.surface}</span>}
                  <span
                    data-testid={`admin-feedback-status-${r.id}`}
                    style={{
                      marginLeft: "0.5rem",
                      padding: "0.1rem 0.5rem",
                      borderRadius: "10px",
                      fontSize: "0.7rem",
                      background: isResolved ? "rgba(74,222,128,0.12)" : "rgba(241,194,51,0.12)",
                      color: isResolved ? "#4ade80" : "var(--wp-gold, #f1c233)",
                      border: `1px solid ${isResolved ? "#4ade80" : "var(--wp-gold, #f1c233)"}`,
                    }}
                  >
                    {isResolved ? "RESOLVED" : "OPEN"}
                  </span>
                </div>
                <div title={r.created_at} style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>
                  {relativeTime(r.created_at)}
                </div>
              </div>
              {(r.times_filed ?? 1) > 1 && (
                <div
                  data-testid={`admin-feedback-times-filed-${r.id}`}
                  style={{
                    marginTop: "0.35rem",
                    fontSize: "0.72rem",
                    color: "var(--wp-text-muted, #6b7280)",
                  }}
                >
                  Filed {r.times_filed} times, first on {shortDate(r.created_at)}
                  {r.last_filed_at ? `, last ${relativeTime(r.last_filed_at)}` : ""}
                </div>
              )}
              <div
                style={{
                  marginTop: "0.6rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: "0.95rem",
                  lineHeight: 1.5,
                  color: "var(--wp-text, #eee)",
                }}
              >
                {r.message}
              </div>
              {isResolved && r.resolved_at && (
                <div style={{ marginTop: "0.4rem", fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)" }}>
                  Resolved {relativeTime(r.resolved_at)}
                  {r.resolution_note && ` · ${r.resolution_note}`}
                </div>
              )}
              {composingNoteFor === r.id && !isResolved && (
                <div
                  data-testid={`admin-feedback-note-form-${r.id}`}
                  style={{ marginTop: "0.6rem" }}
                >
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="What did you do to address this? (optional, but helpful for the team)"
                    data-testid={`admin-feedback-note-input-${r.id}`}
                    rows={3}
                    maxLength={1000}
                    autoFocus
                    style={{
                      width: "100%",
                      padding: "0.5rem 0.75rem",
                      fontSize: "0.85rem",
                      background: "var(--wp-dark-surface2, #1a1a1a)",
                      color: "var(--wp-text, #eee)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      borderRadius: "6px",
                      resize: "vertical",
                      fontFamily: "inherit",
                    }}
                  />
                  <div
                    style={{
                      marginTop: "0.4rem",
                      display: "flex",
                      gap: "0.4rem",
                      justifyContent: "flex-end",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "0.7rem", color: "var(--wp-text-muted, #6b7280)", marginRight: "auto" }}>
                      {noteDraft.length}/1000
                    </span>
                    <button
                      type="button"
                      onClick={cancelComposing}
                      data-testid={`admin-feedback-note-cancel-${r.id}`}
                      style={{
                        padding: "0.3rem 0.75rem",
                        borderRadius: "6px",
                        fontSize: "0.75rem",
                        background: "transparent",
                        color: "var(--wp-text-dim, #aaa)",
                        border: "1px solid var(--wp-dark-border, #333)",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleResolved(r, noteDraft)}
                      disabled={busyId === r.id}
                      data-testid={`admin-feedback-note-submit-${r.id}`}
                      style={{
                        padding: "0.3rem 0.85rem",
                        borderRadius: "6px",
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        background: "var(--wp-gold, #f1c233)",
                        color: "var(--wp-dark, #111)",
                        border: "1px solid var(--wp-gold, #f1c233)",
                        cursor: busyId === r.id ? "not-allowed" : "pointer",
                      }}
                    >
                      {busyId === r.id ? "…" : "Resolve with note"}
                    </button>
                  </div>
                </div>
              )}
              <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                <div style={{ fontSize: "0.7rem", color: "var(--wp-text-muted, #6b7280)" }}>#{r.id.slice(0, 8)}</div>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {!isResolved && composingNoteFor !== r.id && (
                    <button
                      type="button"
                      onClick={() => startComposing(r.id)}
                      data-testid={`admin-feedback-add-note-${r.id}`}
                      style={{
                        padding: "0.35rem 0.85rem",
                        borderRadius: "6px",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                        background: "var(--wp-dark-surface2, #1a1a1a)",
                        color: "var(--wp-text-dim, #aaa)",
                        border: "1px solid var(--wp-dark-border, #333)",
                        fontWeight: 500,
                      }}
                    >
                      Comment + resolve
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`admin-feedback-toggle-${r.id}`}
                    onClick={() => void toggleResolved(r)}
                    disabled={busyId === r.id || composingNoteFor === r.id}
                    style={{
                      padding: "0.35rem 0.85rem",
                      borderRadius: "6px",
                      fontSize: "0.8rem",
                      cursor: busyId === r.id || composingNoteFor === r.id ? "not-allowed" : "pointer",
                      background: isResolved ? "var(--wp-dark-surface2, #1a1a1a)" : "var(--wp-gold, #f1c233)",
                      color: isResolved ? "var(--wp-text-dim, #aaa)" : "var(--wp-dark, #111)",
                      border: `1px solid ${isResolved ? "var(--wp-dark-border, #333)" : "var(--wp-gold, #f1c233)"}`,
                      fontWeight: 500,
                      opacity: composingNoteFor === r.id ? 0.5 : 1,
                    }}
                  >
                    {busyId === r.id ? "…" : isResolved ? "Reopen" : "Mark resolved"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
