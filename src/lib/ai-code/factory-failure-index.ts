/**
 * Factory brain pt3-B: the DERIVED vector index + similarity search over the
 * FAILURE/PATTERN memory (pt3-A, Postgres source of truth).
 *
 *   indexFailureMemory  - embed the un-embedded failure summaries and upsert their
 *                         vectors to Qdrant (collection instinct_factory_failures),
 *                         then mark them embedded. Idempotent.
 *   searchFailureMemory - embed a query (the task/prompt) and return the nearest
 *                         past failures for this repo, so authoring can be warned
 *                         "we've been burned by X here" (pt3-C consumer).
 *
 * Mirrors factory-reuse-index (same never-throw + degrade posture, reuses the
 * factory-vector Qdrant client); the only differences are the collection, the
 * payload (finding_class/summary/path/severity), and that search returns the
 * description, not just a path. A separate collection from the reuse corpus so the
 * two memories never cross.
 */
import {
  loadUnembeddedFailures,
  markFailuresEmbedded,
  type FailureRow,
} from "./factory-failure-store";
import {
  qdrantConfigFromEnv,
  ensureCollection,
  upsertPoints,
  searchPoints,
  pointId,
  type QdrantConfig,
  type VectorHit,
} from "./factory-vector";

export const FACTORY_FAILURE_COLLECTION = "instinct_factory_failures";

export interface FailureHit {
  findingClass: string;
  summary: string;
  path: string;
  severity: string;
  score: number;
}

/** Injected seam for tests; defaults wire the real embedder + Qdrant + store. */
export interface FailureIndexDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantConfig | null;
  loadUnembedded: (workspaceId: string, repo: string, limit: number) => Promise<FailureRow[]>;
  markEmbedded: (workspaceId: string, repo: string, signatures: string[]) => Promise<void>;
  ensure: typeof ensureCollection;
  upsert: typeof upsertPoints;
  search: typeof searchPoints;
}

/** Real deps, lazily (keeps the rag-provider import off the cold path). Null when
 *  no embedder is configured -> caller degrades (no failure warnings this run). */
export async function defaultFailureIndexDeps(): Promise<FailureIndexDeps | null> {
  let embed: FailureIndexDeps["embed"];
  try {
    const { getEmbeddingProvider } = await import("@/lib/rag-providers/factory");
    const provider = getEmbeddingProvider(); // throws when unconfigured
    embed = (texts) => provider.embed(texts);
  } catch {
    return null;
  }
  return {
    embed,
    qdrant: qdrantConfigFromEnv(),
    loadUnembedded: loadUnembeddedFailures,
    markEmbedded: markFailuresEmbedded,
    ensure: ensureCollection,
    upsert: upsertPoints,
    search: searchPoints,
  };
}

const keyFor = (workspaceId: string, repo: string, signature: string) => `${workspaceId}|${repo}|${signature}`;

/** Embed + index the un-embedded failure memories for a repo. Never throws; on
 *  any failure writes nothing and leaves rows embedded=false (retried later). */
export async function indexFailureMemory(args: {
  workspaceId: string;
  repo: string;
  limit?: number;
  deps?: FailureIndexDeps | null;
}): Promise<{ indexed: number }> {
  const deps = args.deps ?? (await defaultFailureIndexDeps());
  if (!deps || !deps.qdrant) return { indexed: 0 };
  try {
    const rows = await deps.loadUnembedded(args.workspaceId, args.repo, args.limit ?? 500);
    if (rows.length === 0) return { indexed: 0 };
    const vectors = await deps.embed(rows.map((r) => r.summary));
    if (!Array.isArray(vectors) || vectors.length !== rows.length || vectors[0]?.length === undefined) {
      return { indexed: 0 };
    }
    const ok = await deps.ensure(deps.qdrant, FACTORY_FAILURE_COLLECTION, vectors[0].length);
    if (!ok) return { indexed: 0 };
    const points = rows.map((r, i) => ({
      id: pointId(keyFor(args.workspaceId, args.repo, r.signature)),
      vector: vectors[i],
      payload: { workspace_id: args.workspaceId, repo: args.repo, finding_class: r.findingClass, summary: r.summary, path: r.path, severity: r.severity },
    }));
    const wrote = await deps.upsert(deps.qdrant, FACTORY_FAILURE_COLLECTION, points);
    if (!wrote) return { indexed: 0 };
    await deps.markEmbedded(args.workspaceId, args.repo, rows.map((r) => r.signature));
    return { indexed: points.length };
  } catch {
    return { indexed: 0 };
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Nearest past failures to a task/prompt, workspace+repo scoped. [] when the
 *  index is cold/down or the embedder is unavailable. */
export async function searchFailureMemory(args: {
  workspaceId: string;
  repo: string;
  query: string;
  k?: number;
  deps?: FailureIndexDeps | null;
}): Promise<FailureHit[]> {
  const q = args.query.trim();
  if (!q) return [];
  const deps = args.deps ?? (await defaultFailureIndexDeps());
  if (!deps || !deps.qdrant) return [];
  try {
    const vectors = await deps.embed([q]);
    const vec = Array.isArray(vectors) ? vectors[0] : undefined;
    if (!vec || vec.length === 0) return [];
    const hits: VectorHit[] = await deps.search(
      deps.qdrant,
      FACTORY_FAILURE_COLLECTION,
      vec,
      { workspace_id: args.workspaceId, repo: args.repo },
      Math.min(Math.max(args.k ?? 5, 1), 50),
    );
    return hits
      .map((h) => ({
        findingClass: str(h.payload.finding_class),
        summary: str(h.payload.summary),
        path: str(h.payload.path),
        severity: str(h.payload.severity) || "high",
        score: h.score,
      }))
      .filter((h) => h.summary !== "");
  } catch {
    return [];
  }
}
