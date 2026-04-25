"use client";

/**
 * /meetings/feeds — list of meeting-insights feeds + create form.
 *
 * Read-only for `meetings.view`; the create form silently no-ops on
 * 403 from `meetings.manage`, surfacing a friendly disabled state.
 *
 * All authenticated client fetches go through `fetchWithRefresh` per
 * the no-raw-api-fetch guardrail.
 */

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

export default function MeetingFeedsPage() {
  const searchParams = useSearchParams();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-form state
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formSenders, setFormSenders] = useState("");
  const [formSubjects, setFormSubjects] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Phase 5: prefill from /meetings/analyze "Save as feed" button.
  // Honored once on mount — re-visiting the page without prefill leaves
  // the form alone.
  useEffect(() => {
    const raw = searchParams?.get("prefill");
    if (!raw) return;
    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as {
        sender_match?: string[];
        subject_match?: string[];
      };
      if (Array.isArray(parsed.sender_match)) {
        setFormSenders(parsed.sender_match.join(", "));
      }
      if (Array.isArray(parsed.subject_match)) {
        setFormSubjects(parsed.subject_match.join(", "));
      }
      setFormOpen(true);
    } catch {
      // Malformed prefill — silently ignore. The user can still hand-type.
    }
  }, [searchParams]);

  async function loadFeeds() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/meetings/feeds");
      if (res.status === 401) {
        window.location.href = "/login?next=/meetings/feeds";
        return;
      }
      if (!res.ok) {
        setError(`Failed to load feeds (${res.status})`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { feeds: Feed[] };
      setFeeds(data.feeds ?? []);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFeeds();
  }, []);

  async function handleCreate(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    setFormSubmitting(true);
    try {
      const senders = formSenders
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const subjects = formSubjects
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetchWithRefresh("/api/meetings/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName,
          description: formDescription || null,
          filters: {
            sender_match: senders,
            subject_match: subjects,
          },
          is_enabled: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        setFormError(body?.detail || body?.error || `Create failed (${res.status})`);
        setFormSubmitting(false);
        return;
      }
      setFormName("");
      setFormDescription("");
      setFormSenders("");
      setFormSubjects("");
      setFormOpen(false);
      await loadFeeds();
    } catch (err) {
      setFormError(`Network error: ${(err as Error).message}`);
    } finally {
      setFormSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Meeting Insights</h1>
          <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
            Configure recurring email feeds to capture meeting threads
            into searchable rows. Each feed watches a set of senders or
            subject lines.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link
            href="/meetings/analyze"
            data-testid="meeting-feed-analyze-link"
            style={{
              background: "transparent",
              color: "var(--wp-gold)",
              border: "1px solid var(--wp-gold)",
              borderRadius: "8px",
              padding: "0.6rem 1.2rem",
              fontSize: "0.9rem",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Ad-hoc analysis
          </Link>
          <button
            type="button"
            data-testid="meeting-feed-new"
            onClick={() => setFormOpen((v) => !v)}
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem 1.2rem",
              fontSize: "0.9rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {formOpen ? "Cancel" : "New feed"}
          </button>
        </div>
      </div>

      {formOpen && (
        <form
          onSubmit={handleCreate}
          data-testid="meeting-feed-form"
          style={{
            marginBottom: "1.5rem",
            padding: "1rem 1.25rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "8px",
            display: "grid",
            gap: "0.75rem",
          }}
        >
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
              Name
            </span>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              required
              maxLength={200}
              placeholder="e.g. Porsche Weekly Stand-up"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
              Description (optional)
            </span>
            <textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
              Sender substrings (comma or newline separated)
            </span>
            <textarea
              value={formSenders}
              onChange={(e) => setFormSenders(e.target.value)}
              rows={2}
              placeholder="@example.com, weekly-bot@example.com"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
              Subject substrings (comma or newline separated)
            </span>
            <textarea
              value={formSubjects}
              onChange={(e) => setFormSubjects(e.target.value)}
              rows={2}
              placeholder="Stand-up, Weekly review"
              style={inputStyle}
            />
          </label>
          {formError && (
            <div style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}>
              {formError}
            </div>
          )}
          <div>
            <button
              type="submit"
              disabled={formSubmitting}
              data-testid="meeting-feed-form-submit"
              style={{
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
                border: "none",
                borderRadius: "8px",
                padding: "0.5rem 1rem",
                fontWeight: 600,
                cursor: "pointer",
                opacity: formSubmitting ? 0.6 : 1,
              }}
            >
              {formSubmitting ? "Saving..." : "Create feed"}
            </button>
          </div>
        </form>
      )}

      {loading && <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>}
      {error && <div style={{ color: "var(--wp-error)" }}>{error}</div>}

      {!loading && !error && feeds.length === 0 && (
        <div
          style={{
            padding: "3rem",
            textAlign: "center",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
          }}
          data-testid="meeting-feeds-empty"
        >
          No feeds yet. Create one to start ingesting.
        </div>
      )}

      {!loading && feeds.length > 0 && (
        <div style={{ display: "grid", gap: "0.75rem" }} data-testid="meeting-feeds-list">
          {feeds.map((f) => (
            <Link
              key={f.id}
              href={`/meetings/feeds/${f.slug}`}
              data-testid={`meeting-feed-row-${f.slug}`}
              style={{
                display: "block",
                padding: "1rem 1.25rem",
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                borderRadius: "8px",
                textDecoration: "none",
                color: "var(--wp-text)",
                opacity: f.is_enabled ? 1 : 0.55,
              }}
            >
              <div
                style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>
                    {f.name} {!f.is_enabled && <span style={{ color: "var(--wp-text-dim)" }}>(disabled)</span>}
                  </div>
                  {f.description && (
                    <div
                      style={{
                        color: "var(--wp-text-dim)",
                        fontSize: "0.85rem",
                        marginTop: "0.3rem",
                      }}
                    >
                      {f.description}
                    </div>
                  )}
                  <div
                    style={{
                      color: "var(--wp-text-dim)",
                      fontSize: "0.75rem",
                      marginTop: "0.6rem",
                    }}
                  >
                    {f.filters.sender_match.length} sender filter(s) ·{" "}
                    {f.filters.subject_match.length} subject filter(s)
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
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
