/**
 * rag-providers/types.ts
 *
 * Provider-abstraction interfaces for the Instinct RAG stack (vector +
 * graph + embeddings). These are the *only* surface the rest of the app
 * should depend on when routing writes/reads through RAG — so we can
 * swap between:
 *
 *   Vector : Qdrant              <-> Azure AI Search
 *   Graph  : Neo4j               <-> Apache AGE (Postgres extension)
 *   Embed  : OpenAI              <-> Azure OpenAI
 *
 * Multi-tenant invariant (hard): every write carries an explicit
 * `tenantId`. The types enforce this at the signature level so adapters
 * cannot accidentally land cross-tenant data. See `config.ts` for how
 * env selects which adapter(s) are live, and `factory.ts` for the
 * wire-up stubs.
 */

/**
 * One document bound for the vector store. `embedding` is optional
 * because some adapters (e.g. Azure AI Search `integrated vectorization`)
 * compute the vector server-side; when absent, the adapter is expected
 * to derive it from `text` via the configured embedding provider.
 */
export interface VectorDoc {
  /** Stable, app-owned id. Adapters must upsert by this. */
  id: string;
  /** Raw text chunk — required for keyword/hybrid/semantic modes. */
  text: string;
  /** Optional pre-computed embedding. Dimensions must match the provider. */
  embedding?: number[];
  /** Free-form payload. Adapters MUST NOT strip keys. */
  metadata: Record<string, unknown>;
  /** Hard multi-tenant key. Never optional. */
  tenantId: string;
}

/** One scored hit returned by `VectorStore.search`. */
export interface VectorSearchHit {
  id: string;
  text: string;
  /** Adapter-normalized score; higher is better. */
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * Search request shape. `mode` lets the caller pick how the adapter
 * should interpret the query — every adapter is expected to support at
 * least `"vector"`; others may degrade to vector when unsupported.
 */
export interface VectorSearchOptions {
  query: string;
  queryEmbedding?: number[];
  /** Hard multi-tenant key. Never optional. */
  tenantId: string;
  topK?: number;
  filter?: Record<string, unknown>;
  mode?: "vector" | "keyword" | "hybrid" | "semantic";
}

/**
 * Unified vector store interface. Adapter implementations live in
 * sibling files (qdrant-vector.ts, azure-ai-search-vector.ts, etc.) and
 * are wired up through `factory.ts`.
 */
export interface VectorStore {
  /** Human-readable adapter name, e.g. `"qdrant"`, `"azure_ai_search"`. */
  name: string;
  /** Upsert docs. Returns the number actually written (post-dedupe). */
  upsert(docs: VectorDoc[]): Promise<{ written: number }>;
  search(opts: VectorSearchOptions): Promise<VectorSearchHit[]>;
  /** Tenant-scoped delete. Adapter MUST refuse cross-tenant ids. */
  delete(ids: string[], tenantId: string): Promise<{ deleted: number }>;
  /** Lightweight liveness + latency probe. Must not throw. */
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

/**
 * Embedding provider. `dimensions` is `null` when the model is variable-
 * dimension (e.g. Matryoshka) and the caller must cope — most callers
 * should assert a concrete number.
 */
export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number | null;
  /** Batched embed. Order of `texts` must be preserved in the result. */
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

/** One node in the knowledge graph. `tenantId` is never optional. */
export interface GraphNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
  tenantId: string;
}

/**
 * One directed edge. `from`/`to` refer to `GraphNode.id`. The edge
 * itself is tenant-scoped even when endpoints are tenant-scoped — this
 * prevents cross-tenant relationships from leaking into queries.
 */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  props: Record<string, unknown>;
  tenantId: string;
}

/**
 * Unified graph store interface. Cypher is the lingua franca — AGE
 * speaks Cypher via `cypher()` wrapper, Neo4j speaks it natively.
 */
export interface GraphStore {
  name: string;
  upsertNode(n: GraphNode): Promise<void>;
  upsertEdge(e: GraphEdge): Promise<void>;
  /**
   * Raw Cypher query. Adapters MUST NOT append tenant predicates
   * automatically; callers are responsible for passing `tenantId` in
   * `params` and filtering via `WHERE n.tenantId = $tenantId`.
   */
  query(cypher: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}
