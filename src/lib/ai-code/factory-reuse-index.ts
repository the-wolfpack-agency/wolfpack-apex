/**
 * Factory brain pt2: the DERIVED vector index + similarity search over the reuse
 * corpus (pt1, Postgres source of truth).
 *
 *   indexReuseCorpus  - embed the un-embedded corpus rows and upsert their vectors
 *                       to Qdrant, then mark them embedded in Postgres. Idempotent:
 *                       re-running only processes rows a change reset to embedded=false.
 *   searchReuseCorpus - embed a query and return the nearest persisted paths,
 *                       workspace+repo scoped. This is what lets the reuse-scout
 *                       SEARCH an accumulated memory instead of re-embedding the
 *                       candidate set on every run.
 *
 * Both NEVER throw and degrade to a safe default (indexed:0 / []) when the
 * embedder or Qdrant is unavailable - a cold or down index never breaks a run.
 * Deps are injected so the orchestration unit-tests hermetically.
 */
import {
  loadUnembeddedCorpus,
  markCorpusEmbedded,
  loadReuseConfidence,
  type ReuseCorpusRow,
} from "./factory-reuse-store";
import {
  qdrantConfigFromEnv,
  ensureCollection,
  upsertPoints,
  searchPoints,
  pointId,
  rerankByConfidence,
  FACTORY_REUSE_COLLECTION,
  type QdrantConfig,
  type VectorHit,
} from "./factory-vector";

export interface ReuseSearchHit {
  path: string;
  score: number;
}

/** Injected seam for tests; defaults wire the real embedder + Qdrant + store. */
export interface ReuseIndexDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantConfig | null;
  loadUnembedded: (workspaceId: string, repo: string, limit: number) => Promise<ReuseCorpusRow[]>;
  markEmbedded: (workspaceId: string, repo: string, paths: string[]) => Promise<void>;
  ensure: typeof ensureCollection;
  upsert: typeof upsertPoints;
  search: typeof searchPoints;
  /** Per-path confidence lookup for weight-aware retrieval (defaults to the store). */
  loadConfidence?: (workspaceId: string, repo: string, paths: string[]) => Promise<Map<string, number>>;
}

/** Build the real deps lazily (keeps the rag-provider import off the hot path
 *  until the brain is actually used). Returns null embedder-less deps if the
 *  embedder can't be resolved, so callers degrade cleanly. */
export async function defaultReuseIndexDeps(): Promise<ReuseIndexDeps | null> {
  let embed: ReuseIndexDeps["embed"];
  try {
    const { getEmbeddingProvider } = await import("@/lib/rag-providers/factory");
    const provider = getEmbeddingProvider(); // throws if unconfigured
    embed = (texts) => provider.embed(texts);
  } catch {
    return null; // no embedder -> caller falls back to the keyword path
  }
  return {
    embed,
    qdrant: qdrantConfigFromEnv(),
    loadUnembedded: loadUnembeddedCorpus,
    markEmbedded: markCorpusEmbedded,
    ensure: ensureCollection,
    upsert: upsertPoints,
    search: searchPoints,
    loadConfidence: loadReuseConfidence,
  };
}

const keyFor = (workspaceId: string, repo: string, path: string) => `${workspaceId}|${repo}|${path}`;

/**
 * Embed + index the un-embedded corpus rows for a repo. Returns how many vectors
 * were written. Never throws. On a Qdrant/embedder failure it writes nothing and
 * leaves the rows embedded=false (retried next time) - the index is derived, so a
 * failed index is a no-op, never data loss.
 */
export async function indexReuseCorpus(args: {
  workspaceId: string;
  repo: string;
  limit?: number;
  deps?: ReuseIndexDeps | null;
}): Promise<{ indexed: number }> {
  const deps = args.deps ?? (await defaultReuseIndexDeps());
  if (!deps || !deps.qdrant) return { indexed: 0 };
  try {
    const rows = await deps.loadUnembedded(args.workspaceId, args.repo, args.limit ?? 500);
    if (rows.length === 0) return { indexed: 0 };
    const vectors = await deps.embed(rows.map((r) => r.text));
    if (!Array.isArray(vectors) || vectors.length !== rows.length || vectors[0]?.length === undefined) {
      return { indexed: 0 }; // embedder returned nothing usable -> retry later
    }
    const ok = await deps.ensure(deps.qdrant, FACTORY_REUSE_COLLECTION, vectors[0].length);
    if (!ok) return { indexed: 0 };
    const points = rows.map((r, i) => ({
      id: pointId(keyFor(args.workspaceId, args.repo, r.path)),
      vector: vectors[i],
      payload: { workspace_id: args.workspaceId, repo: args.repo, path: r.path },
    }));
    const wrote = await deps.upsert(deps.qdrant, FACTORY_REUSE_COLLECTION, points);
    if (!wrote) return { indexed: 0 };
    // Only mark embedded AFTER the vectors landed, so a failed upsert is retried.
    await deps.markEmbedded(args.workspaceId, args.repo, rows.map((r) => r.path));
    return { indexed: points.length };
  } catch {
    return { indexed: 0 };
  }
}

/**
 * Nearest persisted paths to a query, workspace+repo scoped. [] when the index is
 * cold/down or the embedder is unavailable - the caller then uses the keyword path.
 */
export async function searchReuseCorpus(args: {
  workspaceId: string;
  repo: string;
  query: string;
  k?: number;
  deps?: ReuseIndexDeps | null;
}): Promise<ReuseSearchHit[]> {
  const q = args.query.trim();
  if (!q) return [];
  const deps = args.deps ?? (await defaultReuseIndexDeps());
  if (!deps || !deps.qdrant) return [];
  try {
    const vectors = await deps.embed([q]);
    const vec = Array.isArray(vectors) ? vectors[0] : undefined;
    if (!vec || vec.length === 0) return [];
    const hits: VectorHit[] = await deps.search(
      deps.qdrant,
      FACTORY_REUSE_COLLECTION,
      vec,
      { workspace_id: args.workspaceId, repo: args.repo },
      Math.min(Math.max(args.k ?? 6, 1), 50),
    );
    const mapped = hits
      .map((h) => ({ path: typeof h.payload.path === "string" ? h.payload.path : "", score: h.score }))
      .filter((h) => h.path !== "");
    // Weight-aware retrieval: a proven path outranks a doubtful one. Confidence is
    // authoritative in Postgres (looked up here), so it reflects reinforcement
    // without re-embedding. All-1.0 (today) leaves the order unchanged.
    const confidence = await (deps.loadConfidence ?? loadReuseConfidence)(args.workspaceId, args.repo, mapped.map((m) => m.path));
    return rerankByConfidence(mapped, (m) => m.path, confidence);
  } catch {
    return [];
  }
}
