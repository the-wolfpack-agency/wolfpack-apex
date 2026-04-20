"use client";

/**
 * rag-offline — Offline cached-retrieval primitive for RAG callers
 * (Path C — Stream U5).
 *
 * Sits on top of `offline-cache.ts` and lets any RAG caller (assistant,
 * brain, knowledge, client docs, ...) stash query+answer+sources
 * snapshots keyed by a normalized query fingerprint. When offline — or
 * when a freshly-issued query is semantically close to something we
 * already answered — the caller can skip the network round-trip and
 * show the snapshot with a "From snapshot · 2h ago" pill.
 *
 * Key design choices:
 *
 *   1. Fingerprint-keyed. `resource_id` is the fingerprint, not the raw
 *      query. "  What's  the Plan? " and "whats the plan" collapse to
 *      the same key so repeat asks hit cache even when the user retypes.
 *   2. Composite scope. `resource_type = "rag_result::${scope}"` — this
 *      lets `listCachedResources("rag_result::assistant")` return ONLY
 *      assistant hits, never brain/knowledge. Stream U2 wiring can use
 *      one scope per surface without fear of cross-talk.
 *   3. Two-stage lookup. Exact fingerprint first (O(1)). Miss → Jaccard
 *      similarity on query_tokens, returning the best match above
 *      `minSimilarity` (default 0.7). This is why we stash
 *      `query_tokens` alongside the fingerprint: fuzzy lookup stays in
 *      the cache layer and never touches the network.
 *   4. Bounded per scope. Default cap is 50 entries per scope; oldest
 *      drops on overflow. `evictOldRagResults` exposes TTL-style pruning
 *      for callers that want age-based eviction (e.g. stale news docs).
 *   5. Analytics are emitted FROM THIS MODULE (per CLAUDE.md — every
 *      feature feeds the learning loop). Four events: `rag.result_cached`,
 *      `rag.served_from_cache`, `rag.cache_miss_offline`, `rag.cache_evicted`.
 *      Badge component does not fire analytics on its own.
 *
 * This module is UI-primitive-level. Stream U2 wires it into assistant,
 * brain, and knowledge flows. Do NOT import server-only modules here —
 * the whole point is offline-first.
 */

import {
  cacheResource,
  readCachedResource,
  listCachedResources,
  clearResource,
  type ResourceCacheEntry,
} from "@/lib/offline-cache";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedRagSource {
  id: string;
  title?: string;
  score?: number;
}

export interface CachedRagResult<T = unknown> {
  /** Raw query text as the user typed it. */
  query: string;
  /**
   * Normalized key — lowercase, whitespace collapsed, punctuation
   * stripped, stopwords removed, tokens joined with single spaces. Used
   * as the `resource_id` so round-trips across minor whitespace/casing
   * hit the same entry.
   */
  query_fingerprint: string;
  /** Tokenized (post-stopword-strip) — fuels Jaccard similarity. */
  query_tokens: string[];
  /** Retrieved docs in caller-specified shape. */
  retrieved_docs: T[];
  /** Final answer text rendered to the user. */
  answer: string;
  /** Source citations (id + optional title / score). */
  sources: CachedRagSource[];
  /**
   * Sub-scope — "assistant" | "brain" | "knowledge" | caller-defined
   * string. Forms the composite resource_type `rag_result::${scope}`.
   */
  scope: string;
  /** Cache write time (ms epoch). */
  cached_at: number;
}

export interface FindOptions {
  /** Skip fuzzy match if true. Default: false. */
  exactOnly?: boolean;
  /** Jaccard threshold for fuzzy match. Default: 0.7. */
  minSimilarity?: number;
  /**
   * When true, skip firing `rag.cache_miss_offline` on a total miss.
   * Used by tests and by callers that want to probe the cache without
   * polluting the offline-gap dashboard.
   */
  silentOnMiss?: boolean;
  /**
   * When provided, declares the caller's network state. If `false` and
   * the lookup returns null, we fire `rag.cache_miss_offline`. If
   * `true`, a miss is just a normal cache miss and we stay silent — the
   * caller will fetch fresh instead.
   */
  isOffline?: boolean;
  /** Analytics override for tests. */
  onAnalytics?: (event: string, metadata: AnalyticsMeta) => void;
}

export interface CacheOptions {
  /** Analytics override for tests. */
  onAnalytics?: (event: string, metadata: AnalyticsMeta) => void;
  /**
   * Per-scope cap before oldest entries are evicted. Default 50.
   * Stream U2 callers can lower this for scopes with huge doc
   * payloads (knowledge) or raise it for scopes with small ones
   * (assistant).
   */
  maxEntries?: number;
}

export interface EvictOptions {
  /** Analytics override for tests. */
  onAnalytics?: (event: string, metadata: AnalyticsMeta) => void;
}

export interface RagCacheHit<T = unknown> {
  entry: CachedRagResult<T>;
  /** Jaccard similarity ∈ [0,1]. Exact hit is always 1. */
  similarity: number;
  /** True when matched via fuzzy Jaccard, false when fingerprint-exact. */
  isFuzzy: boolean;
}

type AnalyticsMeta = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tiny inline English stopword list. We deliberately keep this small
 * (~45 entries) — aggressive stripping would collapse too many distinct
 * queries into the same fingerprint. Exported so tests can assert
 * stability; Stream U2 also depends on this set being public so any
 * test of retrieval quality can reproduce the tokenization exactly.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "there",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "why",
  "will",
  "with",
  "you",
  "your",
  // Common contraction forms — after apostrophe stripping these would
  // otherwise survive the split ("what's" -> "whats") and inflate the
  // Jaccard distance between semantically-equivalent queries.
  "dont",
  "hows",
  "isnt",
  "thats",
  "theres",
  "whats",
  "whys",
]);

const DEFAULT_MIN_SIMILARITY = 0.7;
const DEFAULT_MAX_ENTRIES = 50;
const SCOPE_PREFIX = "rag_result";

// ---------------------------------------------------------------------------
// Fingerprint + tokenization
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip punctuation, collapse whitespace, drop stopwords,
 * join tokens with a single space. Stable for minor whitespace/casing
 * variations.
 */
export function fingerprintQuery(query: string): string {
  return tokenizeQuery(query).join(" ");
}

/**
 * Turn a raw query string into a deduped + stopword-stripped array of
 * content tokens. Used for both fingerprinting (joined) and Jaccard
 * similarity (as-is). Short-circuits empty strings and all-stopword
 * queries to an empty array.
 */
export function tokenizeQuery(query: string): string[] {
  if (typeof query !== "string" || query.length === 0) return [];
  // Strip apostrophes first so contractions ("what's", "don't") collapse
  // into a single alphanumeric run ("whats", "dont") rather than
  // splitting into a meaningful word + a dangling one-letter token that
  // would survive the stopword filter. Then replace any remaining
  // non-alphanumeric run with a single space, lowercase.
  const normalized = query
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized.length === 0) return [];
  const raw = normalized.split(/\s+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw) {
    if (!tok) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Jaccard similarity over two token arrays: |A∩B| / |A∪B|.
 * Two empty token sets are defined as 1 (both queries collapsed to
 * "pure stopwords" → indistinguishable).
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Analytics (fire-and-forget, mirrors offline-cache.ts)
// ---------------------------------------------------------------------------

async function postAnalytics(
  event: string,
  metadata: AnalyticsMeta,
): Promise<void> {
  if (typeof window === "undefined") return;
  const token = getInstinctToken();
  if (!token) return;
  try {
    await fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, metadata }),
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}

function defaultEmit(event: string, metadata: AnalyticsMeta): void {
  void postAnalytics(event, metadata);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function scopeToResourceType(scope: string): string {
  return `${SCOPE_PREFIX}::${scope}`;
}

function isCachedRagResult(
  data: unknown,
): data is CachedRagResult<unknown> {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.query === "string" &&
    typeof d.query_fingerprint === "string" &&
    Array.isArray(d.query_tokens) &&
    Array.isArray(d.retrieved_docs) &&
    typeof d.answer === "string" &&
    Array.isArray(d.sources) &&
    typeof d.scope === "string" &&
    typeof d.cached_at === "number"
  );
}

function entryFromCacheRow<T>(
  row: ResourceCacheEntry<unknown>,
): CachedRagResult<T> | null {
  if (!isCachedRagResult(row.data)) return null;
  return row.data as CachedRagResult<T>;
}

// ---------------------------------------------------------------------------
// Public API — write
// ---------------------------------------------------------------------------

/**
 * Cache a freshly-computed RAG result. Callers pass the raw fields;
 * this module derives `query_fingerprint`, `query_tokens`, and
 * `cached_at`. After writing, we evict anything beyond `maxEntries` on
 * that scope (oldest-first) so the per-scope cap is a hard ceiling.
 */
export async function cacheRagResult<T>(
  scope: string,
  result: Omit<
    CachedRagResult<T>,
    "cached_at" | "query_fingerprint" | "query_tokens"
  >,
  opts?: CacheOptions,
): Promise<void> {
  const emit = opts?.onAnalytics ?? defaultEmit;
  const tokens = tokenizeQuery(result.query);
  const fingerprint = tokens.join(" ");
  const cacheable: CachedRagResult<T> = {
    ...result,
    scope,
    query_fingerprint: fingerprint,
    query_tokens: tokens,
    cached_at: Date.now(),
  };

  await cacheResource(scopeToResourceType(scope), fingerprint, cacheable);

  emit("rag.result_cached", {
    scope,
    query_token_count: tokens.length,
    doc_count: result.retrieved_docs.length,
  });

  // Enforce the per-scope cap (oldest-first eviction).
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  await enforceScopeCap(scope, maxEntries, emit);
}

async function enforceScopeCap(
  scope: string,
  maxEntries: number,
  emit: (event: string, metadata: AnalyticsMeta) => void,
): Promise<void> {
  if (maxEntries <= 0) return;
  const rows = await listCachedResources(scopeToResourceType(scope));
  if (rows.length <= maxEntries) return;
  // listCachedResources returns newest-first; the tail is oldest.
  const toDrop = rows.slice(maxEntries);
  for (const row of toDrop) {
    await clearResource(scopeToResourceType(scope), row.resource_id);
  }
  if (toDrop.length > 0) {
    emit("rag.cache_evicted", { scope, count: toDrop.length });
  }
}

// ---------------------------------------------------------------------------
// Public API — read
// ---------------------------------------------------------------------------

/**
 * Exact-or-fuzzy lookup. Returns `null` when no match clears the
 * similarity threshold (or when scope is empty).
 *
 * Analytics:
 *   - `rag.served_from_cache` on any hit (exact OR fuzzy).
 *   - `rag.cache_miss_offline` on a total miss when `isOffline=true`
 *     (the caller confirms there was no network recovery path).
 */
export async function findCachedRagResult<T>(
  scope: string,
  query: string,
  opts?: FindOptions,
): Promise<RagCacheHit<T> | null> {
  const emit = opts?.onAnalytics ?? defaultEmit;
  const minSimilarity = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const tokens = tokenizeQuery(query);
  const fingerprint = tokens.join(" ");
  const resourceType = scopeToResourceType(scope);

  // Stage 1 — exact fingerprint hit (O(1) keyed read). Silent read so
  // we don't double-emit alongside offline-cache's resource event.
  const exact = await readCachedResource<CachedRagResult<T>>(
    resourceType,
    fingerprint,
    { silent: true },
  );
  if (exact && isCachedRagResult(exact.data)) {
    const entry = exact.data as CachedRagResult<T>;
    const cacheAge = Date.now() - entry.cached_at;
    emit("rag.served_from_cache", {
      scope,
      similarity: 1,
      is_fuzzy: false,
      cache_age_ms: cacheAge,
    });
    return { entry, similarity: 1, isFuzzy: false };
  }

  // Stage 2 — fuzzy Jaccard across every cached entry in this scope.
  if (!opts?.exactOnly) {
    const all = await listCachedResources(resourceType);
    let best: { entry: CachedRagResult<T>; similarity: number } | null = null;
    for (const row of all) {
      const entry = entryFromCacheRow<T>(row);
      if (!entry) continue;
      const sim = jaccardSimilarity(tokens, entry.query_tokens);
      if (sim >= minSimilarity && (best === null || sim > best.similarity)) {
        best = { entry, similarity: sim };
      }
    }
    if (best) {
      const cacheAge = Date.now() - best.entry.cached_at;
      emit("rag.served_from_cache", {
        scope,
        similarity: best.similarity,
        is_fuzzy: true,
        cache_age_ms: cacheAge,
      });
      return { entry: best.entry, similarity: best.similarity, isFuzzy: true };
    }
  }

  // Total miss.
  if (opts?.isOffline === true && !opts?.silentOnMiss) {
    emit("rag.cache_miss_offline", { scope });
  }
  return null;
}

/**
 * List every cached RAG result in a scope, newest-first.
 */
export async function listCachedRagResults(
  scope: string,
  limit?: number,
): Promise<CachedRagResult<unknown>[]> {
  const rows = await listCachedResources(scopeToResourceType(scope));
  const mapped: CachedRagResult<unknown>[] = [];
  for (const row of rows) {
    const entry = entryFromCacheRow<unknown>(row);
    if (entry) mapped.push(entry);
  }
  if (typeof limit === "number" && limit >= 0) return mapped.slice(0, limit);
  return mapped;
}

/**
 * Age-based eviction. Drops any entry older than `maxAgeMs` and
 * returns the eviction count. Also fires `rag.cache_evicted` when
 * anything was removed (count > 0).
 */
export async function evictOldRagResults(
  scope: string,
  maxAgeMs: number,
  opts?: EvictOptions,
): Promise<number> {
  const emit = opts?.onAnalytics ?? defaultEmit;
  const now = Date.now();
  const rows = await listCachedResources(scopeToResourceType(scope));
  let evicted = 0;
  for (const row of rows) {
    const entry = entryFromCacheRow<unknown>(row);
    if (!entry) continue;
    if (now - entry.cached_at > maxAgeMs) {
      await clearResource(scopeToResourceType(scope), row.resource_id);
      evicted += 1;
    }
  }
  if (evicted > 0) {
    emit("rag.cache_evicted", { scope, count: evicted });
  }
  return evicted;
}
