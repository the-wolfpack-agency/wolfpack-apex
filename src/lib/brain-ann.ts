"use client";

/**
 * brain-ann — Client-side ANN search over cached Brain pack chunks.
 *
 * Level-2 offline retrieval. The caller runs this when:
 *   1. `navigator.onLine === false`, AND
 *   2. a Brain pack (U3's IDB chunk store) has been downloaded for the
 *      active workspace.
 *
 * We embed the query in-browser with `brain-embeddings.embedQuery`,
 * score every cached chunk by cosine similarity, run a cheap
 * token-overlap keyword scorer in parallel (works even when the
 * embedding model fails to load), and return a merged top-K list that
 * is SHAPE-COMPATIBLE with the `/api/brain/query` server response so
 * the existing Brain UI renders cached hits with zero branching.
 *
 * Merge formula: 0.6 * semantic + 0.4 * keyword (normalized to [0,1]).
 * Deduped by `doc_id` — the highest-scoring chunk per doc survives.
 *
 * Non-goals:
 *   - No vector index. A pack holds at most a few thousand chunks per
 *     workspace; a linear dot-product pass is well under 50ms on
 *     modern CPUs and avoids shipping a WASM ANN library.
 *   - No pagination. Caller passes `topK` (default 10).
 */

import type { CachedChunk } from "@/lib/brain-pack-store";
import { getCachedChunks } from "@/lib/brain-pack-store";
import { embedQuery } from "@/lib/brain-embeddings";
import { tokenizeQuery } from "@/lib/rag-offline";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnnHit {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  document_kind: string;
  chunk_idx: number;
  content: string;
  score: number;
  source: "keyword" | "semantic" | "keyword+semantic";
  snippet: string;
}

export interface AnnSearchResult {
  query: string;
  hits: AnnHit[];
  keyword_hits: number;
  semantic_hits: number;
  latency_ms: number;
}

export interface AnnSearchOptions {
  /** Test seam — replace the pack-store read. */
  loadChunks?: (workspace: string) => Promise<CachedChunk[]>;
  /** Test seam — replace the embedder (returns vector or null). */
  embed?: (query: string) => Promise<number[] | null>;
  /**
   * Analytics override for tests. Replaces trackEvent() — same signature
   * as the analytics primitive (event name + metadata dict).
   */
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
}

type AnalyticsMeta = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOP_K = 10;
const SEMANTIC_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

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

function emit(
  event: "brain.ann_search_performed",
  metadata: AnalyticsMeta,
  override?: AnnSearchOptions["onAnalytics"],
): void {
  if (override) {
    try {
      override(event, metadata);
    } catch {
      /* best-effort */
    }
    return;
  }
  void postAnalytics(event, metadata);
}

/**
 * Dot product / (|a| * |b|). Assumes finite floats. Returns 0 when
 * either vector is zero-length or mismatched; we never throw on bad
 * input because the caller's offline UX must still render something.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Jaccard-ish overlap between tokenized query and chunk text tokens. */
function keywordScore(queryTokens: string[], chunk: CachedChunk): number {
  if (queryTokens.length === 0) return 0;
  const chunkTokens = new Set(tokenizeQuery(chunk.text));
  if (chunkTokens.size === 0) return 0;
  let hits = 0;
  for (const tok of queryTokens) {
    if (chunkTokens.has(tok)) hits += 1;
  }
  // Normalize by query length so a longer query is not penalized.
  return hits / queryTokens.length;
}

function shortSnippet(text: string, max = 180): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function chunkToHit(
  chunk: CachedChunk,
  score: number,
  source: AnnHit["source"],
): AnnHit {
  return {
    chunk_id: chunk.id,
    document_id: chunk.doc_id,
    document_filename: chunk.title || chunk.doc_id,
    document_kind: "other",
    chunk_idx: 0,
    content: chunk.text ?? "",
    score,
    source,
    snippet: shortSnippet(chunk.text ?? ""),
  };
}

/**
 * Keep only the highest-scoring chunk per `doc_id`. We run this AFTER
 * merging so we don't lose a chunk that only scored via the keyword
 * branch.
 */
function dedupByDoc(hits: AnnHit[]): AnnHit[] {
  const best = new Map<string, AnnHit>();
  for (const h of hits) {
    const prev = best.get(h.document_id);
    if (!prev || h.score > prev.score) {
      best.set(h.document_id, h);
    }
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run ANN search against the workspace's cached pack. If the embedding
 * model is unavailable (not loaded, failed, timed out) we gracefully
 * degrade to keyword-only.
 */
export async function searchCachedChunks(
  query: string,
  workspace: string,
  topK: number = DEFAULT_TOP_K,
  opts?: AnnSearchOptions,
): Promise<AnnSearchResult> {
  const t0 = Date.now();
  const loadChunks = opts?.loadChunks ?? getCachedChunks;
  const embed = opts?.embed ?? embedQuery;

  const safeTopK = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : DEFAULT_TOP_K;
  const queryTokens = tokenizeQuery(query);

  let chunks: CachedChunk[] = [];
  try {
    chunks = await loadChunks(workspace);
  } catch {
    chunks = [];
  }

  if (chunks.length === 0) {
    emit(
      "brain.ann_search_performed",
      {
        workspace,
        chunk_count: 0,
        top_k: safeTopK,
        duration_ms: Date.now() - t0,
      },
      opts?.onAnalytics,
    );
    return {
      query,
      hits: [],
      keyword_hits: 0,
      semantic_hits: 0,
      latency_ms: Date.now() - t0,
    };
  }

  // Run keyword scoring unconditionally (no model required).
  const keywordScored: Array<{ chunk: CachedChunk; score: number }> = [];
  for (const chunk of chunks) {
    const score = keywordScore(queryTokens, chunk);
    if (score > 0) keywordScored.push({ chunk, score });
  }
  keywordScored.sort((a, b) => b.score - a.score);

  // Try semantic. `embed` is allowed to return null (model load failed
  // or timed out) — we fall back to keyword-only in that case.
  let queryVec: number[] | null = null;
  try {
    queryVec = await embed(query);
  } catch {
    queryVec = null;
  }

  const semanticScored: Array<{ chunk: CachedChunk; score: number }> = [];
  if (queryVec) {
    for (const chunk of chunks) {
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
        continue;
      }
      const sim = cosineSimilarity(queryVec, chunk.embedding);
      if (sim > 0) semanticScored.push({ chunk, score: sim });
    }
    semanticScored.sort((a, b) => b.score - a.score);
  }

  // Merge by chunk_id with the weighted-average rule.
  const byChunkId = new Map<string, { hit: AnnHit }>();

  for (const s of semanticScored) {
    const merged = chunkToHit(
      s.chunk,
      SEMANTIC_WEIGHT * s.score,
      "semantic",
    );
    byChunkId.set(s.chunk.id, { hit: merged });
  }
  for (const k of keywordScored) {
    const existing = byChunkId.get(k.chunk.id);
    if (existing) {
      existing.hit.score = existing.hit.score + KEYWORD_WEIGHT * k.score;
      existing.hit.source = "keyword+semantic";
    } else {
      byChunkId.set(k.chunk.id, {
        hit: chunkToHit(k.chunk, KEYWORD_WEIGHT * k.score, "keyword"),
      });
    }
  }

  const merged = [...byChunkId.values()].map((x) => x.hit);
  const deduped = dedupByDoc(merged);
  deduped.sort((a, b) => b.score - a.score);
  const hits = deduped.slice(0, safeTopK);

  const result: AnnSearchResult = {
    query,
    hits,
    keyword_hits: keywordScored.length,
    semantic_hits: semanticScored.length,
    latency_ms: Date.now() - t0,
  };

  emit(
    "brain.ann_search_performed",
    {
      workspace,
      chunk_count: chunks.length,
      top_k: safeTopK,
      duration_ms: result.latency_ms,
    },
    opts?.onAnalytics,
  );

  return result;
}
