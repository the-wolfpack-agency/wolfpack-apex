"use client";

/**
 * /meetings/feeds/[slug]/messages/[messageId] — single message view.
 *
 * Renders subject + envelope + body_text + per-attachment row with a
 * download link (501 stub until Stream B merges; the link still
 * appears so layout is stable).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Feed {
  id: string;
  slug: string;
  name: string;
}

interface Message {
  id: string;
  subject: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  received_at: string;
  body_text: string;
  has_attachments: boolean;
}

interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  extracted_text: string | null;
  extraction_status: "extracted" | "unsupported_mime" | "error";
}

export default function MeetingMessageDetailPage() {
  const params = useParams<{ slug: string; messageId: string }>();
  const slug = params?.slug ?? "";
  const messageId = params?.messageId ?? "";

  const [feed, setFeed] = useState<Feed | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug || !messageId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchWithRefresh(
          `/api/meetings/feeds/${slug}/messages/${messageId}`,
        );
        if (res.status === 401) {
          window.location.href = `/login?next=/meetings/feeds/${slug}/messages/${messageId}`;
          return;
        }
        if (res.status === 404) {
          setError("Message not found");
          return;
        }
        if (!res.ok) {
          setError(`Failed to load message (${res.status})`);
          return;
        }
        const data = (await res.json()) as {
          feed: Feed;
          message: Message;
          attachments: Attachment[];
        };
        setFeed(data.feed);
        setMessage(data.message);
        setAttachments(data.attachments);
      } catch (err) {
        setError(`Network error: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug, messageId]);

  if (loading) {
    return <div style={{ padding: "2rem", color: "var(--wp-text-dim)" }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ padding: "2rem", color: "var(--wp-error)" }}>{error}</div>;
  }
  if (!message || !feed) {
    return <div style={{ padding: "2rem", color: "var(--wp-error)" }}>Message not found</div>;
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <Link
        href={`/meetings/feeds/${slug}`}
        style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", textDecoration: "none" }}
      >
        ← {feed.name}
      </Link>

      <h1 data-testid="meeting-message-subject" style={{ fontSize: "1.5rem", marginTop: "0.75rem" }}>
        {message.subject || "(no subject)"}
      </h1>

      <div
        style={{
          background: "var(--wp-card)",
          border: "1px solid var(--wp-border)",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          color: "var(--wp-text-dim)",
          fontSize: "0.85rem",
          marginTop: "0.75rem",
        }}
      >
        <div>
          <strong style={{ color: "var(--wp-text)" }}>From:</strong>{" "}
          {message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}
        </div>
        <div style={{ marginTop: "0.3rem" }}>
          <strong style={{ color: "var(--wp-text)" }}>To:</strong>{" "}
          {message.to_addresses.join(", ") || "(none)"}
        </div>
        {message.cc_addresses.length > 0 && (
          <div style={{ marginTop: "0.3rem" }}>
            <strong style={{ color: "var(--wp-text)" }}>Cc:</strong>{" "}
            {message.cc_addresses.join(", ")}
          </div>
        )}
        <div style={{ marginTop: "0.3rem" }}>
          <strong style={{ color: "var(--wp-text)" }}>Received:</strong>{" "}
          {new Date(message.received_at).toLocaleString()}
        </div>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Body</h2>
        {message.body_text ? (
          <pre
            data-testid="meeting-message-body"
            style={{
              background: "var(--wp-card)",
              border: "1px solid var(--wp-border)",
              borderRadius: "8px",
              padding: "1rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--wp-text)",
              fontFamily: "inherit",
              fontSize: "0.9rem",
              margin: 0,
            }}
          >
            {message.body_text}
          </pre>
        ) : (
          <div style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}>
            (Body text pending — Stream B parser not yet merged.)
          </div>
        )}
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Attachments ({attachments.length})
        </h2>
        {attachments.length === 0 ? (
          <div style={{ color: "var(--wp-text-dim)" }}>No attachments.</div>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }} data-testid="meeting-attachments-list">
            {attachments.map((att) => (
              <div
                key={att.id}
                style={{
                  background: "var(--wp-card)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                }}
              >
                <div style={{ fontWeight: 600 }}>{att.filename}</div>
                <div style={{ color: "var(--wp-text-dim)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                  {att.mime} · {Math.round(att.size_bytes / 1024)} KB · {att.extraction_status}
                </div>
                {att.extracted_text && (
                  <details style={{ marginTop: "0.5rem" }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
                      Extracted text
                    </summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: "0.4rem" }}>
                      {att.extracted_text}
                    </pre>
                  </details>
                )}
                <div style={{ marginTop: "0.5rem" }}>
                  <a
                    href={`/api/meetings/feeds/${slug}/messages/${messageId}/attachments/${att.id}/download`}
                    style={{ color: "var(--wp-gold)", fontSize: "0.85rem", textDecoration: "none" }}
                  >
                    Download (requires meetings.export)
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
