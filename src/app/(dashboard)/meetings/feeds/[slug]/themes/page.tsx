"use client";

/**
 * /meetings/feeds/[slug]/themes — Phase 3 cross-meeting theme tracker.
 *
 * Three sections:
 *   - Recurring topics (most-frequent across the lookback window)
 *   - Stale topics (raised in window but absent from recent messages)
 *   - Open action items (across the feed)
 *
 * Plus a search box on top that calls the semantic-search endpoint.
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Feed {
  id: string;
  slug: string;
  name: string;
}

interface RecurringTopic {
  topic: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
  message_ids: string[];
}
interface StaleTopic {
  topic: string;
  last_mentioned: string;
  days_silent: number;
  message_ids: string[];
}
interface OpenActionItem {
  message_id: string;
  message_subject: string;
  message_received_at: string;
  description: string;
  owner: string | null;
  due: string | null;
}
interface SemanticHit {
  message_id: string;
  subject: string;
  received_at: string;
  topics: string[];
  score: number;
  highlight: string;
}

export default function ThemesPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";

  const [feed, setFeed] = useState<Feed | null>(null);
  const [recurring, setRecurring] = useState<RecurringTopic[]>([]);
  const [stale, setStale] = useState<StaleTopic[]>([]);
  const [actions, setActions] = useState<OpenActionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SemanticHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchWithRefresh(
          `/api/meetings/feeds/${slug}/themes`,
        );
        if (res.status === 401) {
          window.location.href = `/login?next=/meetings/feeds/${slug}/themes`;
          return;
        }
        if (res.status === 404) {
          setError("Feed not found");
          return;
        }
        if (!res.ok) {
          setError(`Failed to load themes (${res.status})`);
          return;
        }
        const data = (await res.json()) as {
          feed: Feed;
          recurring: RecurringTopic[];
          stale: StaleTopic[];
          action_items: OpenActionItem[];
        };
        setFeed(data.feed);
        setRecurring(data.recurring);
        setStale(data.stale);
        setActions(data.action_items);
      } catch (err) {
        setError(`Network error: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  const runSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!slug || !q.trim()) return;
      setSearching(true);
      setSearchError(null);
      try {
        const res = await fetchWithRefresh(
          `/api/meetings/feeds/${slug}/search?q=${encodeURIComponent(q.trim())}`,
        );
        if (res.status === 401) {
          window.location.href = `/login?next=/meetings/feeds/${slug}/themes`;
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setSearchError(data.error ?? `Search failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as { hits: SemanticHit[] };
        setHits(data.hits);
      } catch (err) {
        setSearchError(`Network error: ${(err as Error).message}`);
      } finally {
        setSearching(false);
      }
    },
    [slug, q],
  );

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
        href={`/meetings/feeds/${slug}`}
        style={{
          color: "var(--wp-text-dim)",
          fontSize: "0.85rem",
          textDecoration: "none",
        }}
      >
        ← {feed.name}
      </Link>

      <h1 style={{ fontSize: "1.5rem", marginTop: "0.75rem" }}>
        Themes — {feed.name}
      </h1>

      {/* ---------- Search ---------- */}
      <form
        data-testid="themes-search"
        onSubmit={runSearch}
        style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}
      >
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search messages…"
          aria-label="search messages"
          style={{
            flex: 1,
            padding: "0.4rem 0.6rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "6px",
            color: "var(--wp-text)",
            fontSize: "0.9rem",
          }}
        />
        <button
          type="submit"
          disabled={searching || !q.trim()}
          style={{
            background: "transparent",
            border: "1px solid var(--wp-border)",
            color: "var(--wp-text-dim)",
            borderRadius: "6px",
            padding: "0.3rem 0.8rem",
            fontSize: "0.85rem",
            cursor: searching || !q.trim() ? "not-allowed" : "pointer",
          }}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {searchError && (
        <div
          style={{
            color: "var(--wp-error)",
            fontSize: "0.85rem",
            marginTop: "0.5rem",
          }}
        >
          {searchError}
        </div>
      )}

      {hits != null && (
        <section data-testid="themes-search-results" style={{ marginTop: "1rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
            Search results ({hits.length})
          </h2>
          {hits.length === 0 ? (
            <div style={{ color: "var(--wp-text-dim)" }}>No results.</div>
          ) : (
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {hits.map((hit) => (
                <Link
                  key={hit.message_id}
                  href={`/meetings/feeds/${slug}/messages/${hit.message_id}`}
                  style={{
                    background: "var(--wp-card)",
                    border: "1px solid var(--wp-border)",
                    borderRadius: "8px",
                    padding: "0.75rem 1rem",
                    textDecoration: "none",
                    color: "var(--wp-text)",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {hit.subject || "(no subject)"}
                  </div>
                  <div
                    style={{
                      color: "var(--wp-text-dim)",
                      fontSize: "0.8rem",
                      marginTop: "0.25rem",
                    }}
                  >
                    {new Date(hit.received_at).toLocaleString()}
                  </div>
                  {hit.highlight && (
                    <div
                      style={{
                        marginTop: "0.4rem",
                        fontSize: "0.85rem",
                        color: "var(--wp-text-dim)",
                      }}
                    >
                      {hit.highlight}
                    </div>
                  )}
                  {hit.topics.length > 0 && (
                    <div style={{ marginTop: "0.4rem" }}>
                      {hit.topics.map((t) => (
                        <span
                          key={t}
                          style={{
                            display: "inline-block",
                            background: "var(--wp-bg)",
                            border: "1px solid var(--wp-border)",
                            borderRadius: "12px",
                            padding: "0.1rem 0.5rem",
                            margin: "0.1rem",
                            fontSize: "0.75rem",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---------- Recurring topics ---------- */}
      <section data-testid="themes-recurring" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Recurring topics ({recurring.length})
        </h2>
        {recurring.length === 0 ? (
          <div style={{ color: "var(--wp-text-dim)" }}>
            No recurring topics yet — analyses are still building up.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {recurring.map((t) => (
              <li
                key={t.topic}
                style={{
                  background: "var(--wp-card)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "8px",
                  padding: "0.6rem 0.9rem",
                  marginBottom: "0.4rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600 }}>{t.topic}</span>
                  <span style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                    {t.mention_count} mention{t.mention_count === 1 ? "" : "s"}
                  </span>
                </div>
                <div
                  style={{
                    color: "var(--wp-text-dim)",
                    fontSize: "0.75rem",
                    marginTop: "0.2rem",
                  }}
                >
                  {new Date(t.first_seen).toLocaleDateString()} →{" "}
                  {new Date(t.last_seen).toLocaleDateString()}
                </div>
                <div style={{ marginTop: "0.3rem" }}>
                  {t.message_ids.slice(0, 5).map((mid) => (
                    <Link
                      key={mid}
                      href={`/meetings/feeds/${slug}/messages/${mid}`}
                      style={{
                        color: "var(--wp-gold)",
                        fontSize: "0.75rem",
                        textDecoration: "none",
                        marginRight: "0.4rem",
                      }}
                    >
                      message
                    </Link>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- Stale topics ---------- */}
      <section data-testid="themes-stale" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Stale topics ({stale.length})
        </h2>
        {stale.length === 0 ? (
          <div style={{ color: "var(--wp-text-dim)" }}>
            No stale topics — every recent topic is still being raised.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {stale.map((t) => (
              <li
                key={t.topic}
                style={{
                  background: "var(--wp-card)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "8px",
                  padding: "0.6rem 0.9rem",
                  marginBottom: "0.4rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600 }}>{t.topic}</span>
                  <span
                    style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}
                  >
                    silent {t.days_silent}d
                  </span>
                </div>
                <div
                  style={{
                    color: "var(--wp-text-dim)",
                    fontSize: "0.75rem",
                    marginTop: "0.2rem",
                  }}
                >
                  Last raised {new Date(t.last_mentioned).toLocaleDateString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- Open action items ---------- */}
      <section data-testid="themes-action-items" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
          Open action items ({actions.length})
        </h2>
        {actions.length === 0 ? (
          <div style={{ color: "var(--wp-text-dim)" }}>
            No open action items.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {actions.map((a, i) => (
              <li
                key={`${a.message_id}-${i}`}
                style={{
                  background: "var(--wp-card)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "8px",
                  padding: "0.6rem 0.9rem",
                  marginBottom: "0.4rem",
                }}
              >
                <div>{a.description}</div>
                <div
                  style={{
                    color: "var(--wp-text-dim)",
                    fontSize: "0.75rem",
                    marginTop: "0.25rem",
                  }}
                >
                  {a.owner ? `Owner: ${a.owner}` : "No owner"}
                  {a.due ? ` · Due ${a.due}` : ""}
                  {" · from "}
                  <Link
                    href={`/meetings/feeds/${slug}/messages/${a.message_id}`}
                    style={{
                      color: "var(--wp-gold)",
                      textDecoration: "none",
                    }}
                  >
                    {a.message_subject || "message"}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
