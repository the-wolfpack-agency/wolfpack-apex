"use client";

/**
 * /search — Universal Search UI (v1).
 *
 * Single search input that hits /api/search and lists results grouped
 * by type (chats / channels / emails / calendar / knowledge). Filter
 * chips at the top narrow the types. URL-state (`?q=...&types=...`)
 * keeps links shareable and the browser back-button sensible.
 *
 * All API calls go through `fetchWithRefresh` per repo hard-rule.
 * Dark theme via `var(--wp-*)`.
 *
 * Every result click fires `insight.search.result_clicked` as a
 * fire-and-forget POST so the backend learns which surfaces + positions
 * actually serve the user. Zero-token UX: the click doesn't wait.
 */

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

type ResultType = "chat" | "channel" | "email" | "calendar" | "knowledge";

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  snippet: string;
  timestamp: string;
  url?: string;
}

interface SearchResponse {
  results: SearchResult[];
  took_ms: number;
  counts: Record<string, number>;
}

const TYPE_LABELS: Record<ResultType, string> = {
  chat: "Chats",
  channel: "Channels",
  email: "Emails",
  calendar: "Calendar",
  knowledge: "Knowledge",
};

const TYPE_ORDER: ResultType[] = ["chat", "channel", "email", "calendar", "knowledge"];

function formatRelative(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff < 0;
  const mag = future ? "in " : "";
  const suf = future ? "" : " ago";
  if (abs < minute) return "just now";
  if (abs < hour) return `${mag}${Math.round(abs / minute)}m${suf}`;
  if (abs < day) return `${mag}${Math.round(abs / hour)}h${suf}`;
  if (abs < 7 * day) return `${mag}${Math.round(abs / day)}d${suf}`;
  return new Date(iso).toLocaleDateString();
}

function fireResultClick(result: SearchResult, position: number): void {
  // Fire-and-forget. Errors are swallowed — analytics must never block
  // the user's navigation.
  try {
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "insight.search.result_clicked",
        metadata: {
          surface: "search",
          action: "result_clicked",
          tier: "personal",
          target: result.id,
          result_type: result.type,
          position,
        },
      }),
    }).catch(() => {});
  } catch {
    // Never throw.
  }
}

function SearchContents() {
  const router = useRouter();
  const params = useSearchParams();
  const initialQ = params.get("q") || "";
  const initialTypes = (params.get("types") || "").split(",").filter(Boolean) as ResultType[];

  const [query, setQuery] = useState(initialQ);
  const [activeTypes, setActiveTypes] = useState<Set<ResultType>>(
    () => new Set(initialTypes.length > 0 ? initialTypes : TYPE_ORDER),
  );
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [tookMs, setTookMs] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [inputFocused, setInputFocused] = useState(false);

  const runTimer = useRef<number | null>(null);

  const typesParam = useMemo(() => {
    if (activeTypes.size === TYPE_ORDER.length) return "";
    return Array.from(activeTypes).join(",");
  }, [activeTypes]);

  const runSearch = useCallback(
    async (q: string, types: Set<ResultType>) => {
      setLoading(true);
      setError("");
      try {
        const qs = new URLSearchParams();
        if (q) qs.set("q", q);
        if (types.size < TYPE_ORDER.length) qs.set("types", Array.from(types).join(","));
        qs.set("limit", "20");
        const res = await fetchWithRefresh(`/api/search?${qs.toString()}`);
        if (!res.ok) {
          setError(`Search failed (${res.status})`);
          setResults([]);
          return;
        }
        const body = (await res.json()) as SearchResponse;
        setResults(body.results || []);
        setTookMs(body.took_ms || 0);
      } catch {
        setError("Search failed — check your connection.");
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Push current query/types to the URL so refresh + back-button work.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (query) qs.set("q", query);
    if (typesParam) qs.set("types", typesParam);
    const next = qs.toString();
    const path = next ? `/search?${next}` : "/search";
    // Use replace to avoid stacking a history entry per keystroke.
    router.replace(path);
  }, [query, typesParam, router]);

  // Debounced run. An empty query stays idle — show the initial prompt
  // instead of firing a wildcard search and dumping every recent record
  // into the page on first load.
  useEffect(() => {
    if (runTimer.current) window.clearTimeout(runTimer.current);
    if (!query.trim()) {
      setLoading(false);
      setResults([]);
      setTookMs(0);
      setError("");
      return;
    }
    runTimer.current = window.setTimeout(() => {
      void runSearch(query, activeTypes);
    }, 250);
    return () => {
      if (runTimer.current) window.clearTimeout(runTimer.current);
    };
  }, [query, activeTypes, runSearch]);

  const toggleType = (t: ResultType): void => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
        // Never leave an empty filter — empty = all, represented as full set.
        if (next.size === 0) return new Set(TYPE_ORDER);
      } else {
        next.add(t);
      }
      return next;
    });
  };

  const grouped = useMemo(() => {
    const g: Record<ResultType, SearchResult[]> = {
      chat: [],
      channel: [],
      email: [],
      calendar: [],
      knowledge: [],
    };
    for (const r of results) g[r.type].push(r);
    return g;
  }, [results]);

  const handleResultClick = (result: SearchResult, positionInGroup: number): void => {
    fireResultClick(result, positionInGroup);
    if (result.url) {
      // Let the browser follow the href naturally — the click handler
      // just fires analytics, doesn't preventDefault.
    }
  };

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
      <h1
        style={{
          color: "var(--wp-text-primary)",
          fontSize: "28px",
          marginBottom: "16px",
        }}
      >
        Search
      </h1>

      <div style={{ marginBottom: "16px", position: "relative" }}>
        {/* Magnifying glass prefix so the field reads as an input
            even before focus — the previous design had a 1px border
            that was nearly invisible against the dark surface and
            users couldn't tell it was clickable. */}
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            position: "absolute",
            left: "14px",
            top: "50%",
            transform: "translateY(-50%)",
            color: inputFocused ? "var(--wp-gold)" : "var(--wp-text-secondary)",
            pointerEvents: "none",
          }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          placeholder="Search chats, emails, calendar..."
          aria-label="Universal search"
          data-testid="search-input"
          autoFocus
          style={{
            width: "100%",
            padding: "12px 16px 12px 44px",
            fontSize: "16px",
            background: "var(--wp-surface)",
            color: "var(--wp-text-primary)",
            border: `2px solid ${inputFocused ? "var(--wp-gold)" : "var(--wp-text-secondary)"}`,
            borderRadius: "8px",
            outline: "none",
            boxShadow: inputFocused
              ? "0 0 0 3px rgba(234, 179, 8, 0.15)"
              : "none",
            transition: "border-color 120ms, box-shadow 120ms",
          }}
        />
      </div>

      <div
        role="group"
        aria-label="Filter by type"
        style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}
      >
        {TYPE_ORDER.map((t) => {
          const active = activeTypes.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              aria-pressed={active}
              data-testid={`chip-${t}`}
              style={{
                padding: "6px 12px",
                borderRadius: "16px",
                border: `1px solid ${active ? "var(--wp-gold)" : "var(--wp-border)"}`,
                background: active ? "var(--wp-gold)" : "transparent",
                color: active ? "var(--wp-bg)" : "var(--wp-text-secondary)",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              {TYPE_LABELS[t]}
            </button>
          );
        })}
      </div>

      <div
        style={{
          color: "var(--wp-text-secondary)",
          fontSize: "13px",
          marginBottom: "12px",
        }}
      >
        {loading ? (
          <span data-testid="search-loading">Searching...</span>
        ) : error ? (
          <span style={{ color: "var(--wp-error)" }} data-testid="search-error">
            {error}
          </span>
        ) : query ? (
          <span data-testid="search-meta">
            {results.length} result{results.length === 1 ? "" : "s"} in {tookMs}ms
          </span>
        ) : null}
      </div>

      {!loading && !error && !query && (
        <div
          data-testid="search-idle"
          style={{
            padding: "32px",
            textAlign: "center",
            color: "var(--wp-text-secondary)",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
          }}
        >
          Type to search across your chats, emails, calendar, and knowledge.
        </div>
      )}

      {!loading && !error && results.length === 0 && query && (
        <div
          data-testid="search-empty"
          style={{
            padding: "24px",
            textAlign: "center",
            color: "var(--wp-text-secondary)",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
          }}
        >
          No results for &ldquo;{query}&rdquo;. Try a different term or remove a filter.
        </div>
      )}

      {TYPE_ORDER.map((t) => {
        const group = grouped[t];
        if (group.length === 0) return null;
        return (
          <section key={t} data-testid={`group-${t}`} style={{ marginBottom: "24px" }}>
            <h2
              style={{
                color: "var(--wp-text-primary)",
                fontSize: "15px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: "10px",
              }}
            >
              {TYPE_LABELS[t]} · {group.length}
            </h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {group.map((r, i) => (
                <li
                  key={r.id}
                  style={{
                    background: "var(--wp-surface)",
                    border: "1px solid var(--wp-border)",
                    borderRadius: "8px",
                    marginBottom: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <a
                    href={r.url || "#"}
                    onClick={() => handleResultClick(r, i)}
                    data-testid={`result-${r.id}`}
                    style={{
                      color: "var(--wp-text-primary)",
                      textDecoration: "none",
                      display: "block",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "12px",
                      }}
                    >
                      <strong style={{ fontSize: "14px" }}>{r.title}</strong>
                      <span
                        style={{
                          color: "var(--wp-text-secondary)",
                          fontSize: "12px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatRelative(r.timestamp)}
                      </span>
                    </div>
                    {r.snippet && (
                      <p
                        style={{
                          color: "var(--wp-text-secondary)",
                          fontSize: "13px",
                          marginTop: "4px",
                          marginBottom: 0,
                        }}
                      >
                        {r.snippet}
                      </p>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export default function SearchPage() {
  // useSearchParams requires a Suspense boundary during server render in
  // Next 14 app-router.
  return (
    <Suspense fallback={<div style={{ padding: "24px" }}>Loading search...</div>}>
      <SearchContents />
    </Suspense>
  );
}
