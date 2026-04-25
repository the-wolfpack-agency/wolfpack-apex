"use client";

/**
 * /meetings/feeds/[slug] — feed detail.
 *
 * Shows: feed metadata, current filters, an edit form (gated to
 * meetings.manage server-side; the UI never disables it but a 403 is
 * surfaced as an error message), a "Run now" button, and the most-
 * recent 5 messages with deep-link to per-message detail.
 */

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Feed {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  filters: { sender_match: string[]; subject_match: string[]; since?: string };
  is_enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  subject: string;
  from_address: string;
  received_at: string;
  has_attachments: boolean;
}

export default function MeetingFeedDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";

  const [feed, setFeed] = useState<Feed | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Edit form state
  const [editOpen, setEditOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  async function handleDelete() {
    /* Soft-delete: API DELETE sets is_enabled=false; the row + all
       ingested messages stay so history is preserved. */
    const ok = window.confirm(
      `Disable feed "${feed?.name ?? slug}"?\n\n` +
        "The feed stops polling but the existing messages and " +
        "analyses stay searchable. You can re-enable later by editing " +
        "and saving.",
    );
    if (!ok) return;
    setDeleteSubmitting(true);
    try {
      const res = await fetchWithRefresh(
        `/api/meetings/feeds/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      );
      if (res.status === 401) {
        window.location.href = "/login?next=/meetings/feeds";
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
        setError(body?.detail || body?.error || `Delete failed (${res.status})`);
        return;
      }
      window.location.href = "/meetings/feeds";
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setDeleteSubmitting(false);
    }
  }
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSenders, setEditSenders] = useState("");
  const [editSubjects, setEditSubjects] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [pollMsg, setPollMsg] = useState<string | null>(null);
  const [pollSubmitting, setPollSubmitting] = useState(false);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/meetings/feeds/${slug}/messages`);
      if (res.status === 401) {
        window.location.href = `/login?next=/meetings/feeds/${slug}`;
        return;
      }
      if (res.status === 404) {
        setError("Feed not found");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`Failed to load feed (${res.status})`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { feed: Feed; messages: MessageRow[] };
      setFeed(data.feed);
      setMessages(data.messages.slice(0, 5));
      setEditName(data.feed.name);
      setEditDescription(data.feed.description ?? "");
      setEditSenders(data.feed.filters.sender_match.join(", "));
      setEditSubjects(data.feed.filters.subject_match.join(", "));
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!slug) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function handleEdit(ev: FormEvent) {
    ev.preventDefault();
    setEditError(null);
    setEditSubmitting(true);
    try {
      const senders = editSenders.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const subjects = editSubjects.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const res = await fetchWithRefresh(`/api/meetings/feeds/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          description: editDescription || null,
          filters: { sender_match: senders, subject_match: subjects },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
        setEditError(body?.detail || body?.error || `Edit failed (${res.status})`);
        setEditSubmitting(false);
        return;
      }
      setEditOpen(false);
      await loadAll();
    } catch (err) {
      setEditError(`Network error: ${(err as Error).message}`);
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handlePoll() {
    setPollMsg(null);
    setPollSubmitting(true);
    try {
      const res = await fetchWithRefresh(`/api/meetings/feeds/${slug}/poll`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
        setPollMsg(body?.detail || body?.error || `Poll failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        result: {
          messages_seen: number;
          messages_matched: number;
          artifacts_ingested: number;
        };
      };
      setPollMsg(
        `Poll complete: ${data.result.messages_seen} seen, ${data.result.messages_matched} matched, ${data.result.artifacts_ingested} ingested.`,
      );
      await loadAll();
    } catch (err) {
      setPollMsg(`Network error: ${(err as Error).message}`);
    } finally {
      setPollSubmitting(false);
    }
  }

  if (loading) {
    return <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ padding: "2rem", color: "var(--wp-error)" }}>{error}</div>;
  }
  if (!feed) {
    return <div style={{ padding: "2rem", color: "var(--wp-error)" }}>Feed not found</div>;
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <Link
        href="/meetings/feeds"
        style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", textDecoration: "none" }}
      >
        ← All feeds
      </Link>

      <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 data-testid="meeting-feed-name" style={{ fontSize: "1.7rem", margin: 0 }}>
            {feed.name}
          </h1>
          {feed.description && (
            <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>{feed.description}</p>
          )}
          <div style={{ color: "var(--wp-text-dim)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
            slug: {feed.slug} · {feed.is_enabled ? "enabled" : "disabled"} · created by {feed.created_by}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handlePoll}
            disabled={pollSubmitting}
            data-testid="meeting-feed-poll-now"
            style={{ ...btnPrimary, opacity: pollSubmitting ? 0.6 : 1 }}
          >
            {pollSubmitting ? "Polling…" : "Run now"}
          </button>
          <button
            type="button"
            onClick={() => setEditOpen((v) => !v)}
            data-testid="meeting-feed-edit-toggle"
            style={btnSecondary}
          >
            {editOpen ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleteSubmitting}
            data-testid="meeting-feed-delete"
            style={{
              ...btnSecondary,
              borderColor: "rgba(204,68,68,0.55)",
              color: "#e07b7b",
              opacity: deleteSubmitting ? 0.6 : 1,
            }}
          >
            {deleteSubmitting ? "Disabling…" : "Delete"}
          </button>
        </div>
      </div>

      {pollMsg && (
        <div data-testid="meeting-feed-poll-result" style={{ marginTop: "1rem", padding: "0.75rem", border: "1px solid var(--wp-border)", borderRadius: "8px", color: "var(--wp-text-dim)" }}>
          {pollMsg}
        </div>
      )}

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Filters</h2>
        <div style={{ background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "8px", padding: "0.75rem 1rem", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
          <div><strong style={{ color: "var(--wp-text)" }}>Senders:</strong> {feed.filters.sender_match.join(", ") || "(any)"}</div>
          <div style={{ marginTop: "0.3rem" }}><strong style={{ color: "var(--wp-text)" }}>Subjects:</strong> {feed.filters.subject_match.join(", ") || "(any)"}</div>
          {feed.filters.since && (
            <div style={{ marginTop: "0.3rem" }}><strong style={{ color: "var(--wp-text)" }}>Since:</strong> {feed.filters.since}</div>
          )}
        </div>
      </section>

      {editOpen && (
        <form
          onSubmit={handleEdit}
          data-testid="meeting-feed-edit-form"
          style={{ marginTop: "1.5rem", padding: "1rem 1.25rem", background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "8px", display: "grid", gap: "0.75rem" }}
        >
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>Name</span>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={200}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>Description</span>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>Senders</span>
            <textarea
              value={editSenders}
              onChange={(e) => setEditSenders(e.target.value)}
              rows={2}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>Subjects</span>
            <textarea
              value={editSubjects}
              onChange={(e) => setEditSubjects(e.target.value)}
              rows={2}
              style={inputStyle}
            />
          </label>
          {editError && (
            <div style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}>{editError}</div>
          )}
          <div>
            <button type="submit" disabled={editSubmitting} style={{ ...btnPrimary, opacity: editSubmitting ? 0.6 : 1 }}>
              {editSubmitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Recent messages</h2>
        {messages.length === 0 ? (
          <div style={{ padding: "1.5rem", border: "1px dashed var(--wp-border)", borderRadius: "8px", color: "var(--wp-text-dim)" }}>
            No messages ingested yet. Once a matching email arrives it will appear here.
          </div>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }} data-testid="meeting-messages-list">
            {messages.map((m) => (
              <Link
                key={m.id}
                href={`/meetings/feeds/${slug}/messages/${m.id}`}
                style={{ background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "8px", padding: "0.75rem 1rem", textDecoration: "none", color: "var(--wp-text)" }}
              >
                <div style={{ fontWeight: 600 }}>{m.subject || "(no subject)"}</div>
                <div style={{ color: "var(--wp-text-dim)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                  {m.from_address} · {new Date(m.received_at).toLocaleString()}{" "}
                  {m.has_attachments && "· has attachments"}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "8px",
  padding: "0.5rem 0.75rem",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
  width: "100%",
  fontFamily: "inherit",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  border: "none",
  borderRadius: "8px",
  padding: "0.5rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  color: "var(--wp-text)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "8px",
  padding: "0.5rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};
