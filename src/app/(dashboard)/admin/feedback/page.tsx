"use client";

/**
 * /admin/feedback — CTO/CEO view of recent /feedback submissions.
 *
 * The widget tells users "The CTO sees every note." This page is the
 * fulfillment of that promise. CTO-only via the capability gate on the
 * API; the page itself just renders whatever the API returns.
 *
 * Minimal on purpose: list with timestamp + sender + message + surface.
 * Sortable by date (descending only for now). No edit, no delete, no
 * reply — that comes later if/when the use case demands it.
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
}

interface FeedbackResponse {
  workspace_id: string;
  count: number;
  limit: number;
  feedback: FeedbackRow[];
}

function relativeTime(iso: string): string {
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

export default function FeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/feedback?limit=200");
      if (!res.ok) {
        if (res.status === 403) {
          setError("You don't have permission to view team feedback.");
        } else {
          setError(`Could not load feedback (HTTP ${res.status}).`);
        }
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.5rem" }}>
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
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0 0 1.5rem 0", fontSize: "0.9rem" }}>
        Every note submitted via the assistant&apos;s <code>/feedback</code> command shows up here. Newest first.
      </p>

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
          No feedback yet. Tell the team to try <code>/feedback &lt;message&gt;</code> in the assistant.
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="admin-feedback-list">
        {rows.map((r) => (
          <li
            key={r.id}
            data-testid={`admin-feedback-row-${r.id}`}
            style={{
              padding: "1rem 1.1rem",
              marginBottom: "0.5rem",
              background: "var(--wp-dark-surface, #1f1f22)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
              <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
                <strong style={{ color: "var(--wp-text, #eee)" }}>
                  {r.user_email ?? r.user_id}
                </strong>
                {r.user_role && (
                  <span style={{ marginLeft: "0.5rem", color: "var(--wp-text-muted, #6b7280)" }}>
                    · {r.user_role}
                  </span>
                )}
                {r.surface && (
                  <span style={{ marginLeft: "0.5rem", color: "var(--wp-text-muted, #6b7280)" }}>
                    · from {r.surface}
                  </span>
                )}
              </div>
              <div
                title={r.created_at}
                style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}
              >
                {relativeTime(r.created_at)}
              </div>
            </div>
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
            <div style={{ marginTop: "0.5rem", fontSize: "0.7rem", color: "var(--wp-text-muted, #6b7280)" }}>
              #{r.id.slice(0, 8)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
