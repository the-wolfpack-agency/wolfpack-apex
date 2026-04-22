/**
 * rag-providers/factory.ts
 *
 * Single entry-point for code that needs a vector/graph/embedding
 * provider. Today every branch throws a clear "not wired" error — the
 * four adapter implementations land in follow-up commits. By going
 * through this factory now (instead of newing up adapters at each call
 * site), consumers get a free compile-time swap when the adapters land.
 *
 * Each call resolves env via `getProviderConfig()` so misconfiguration
 * surfaces loudly at the first use, not silently at query time.
 */

import type { EmbeddingProvider, GraphStore, VectorStore } from "./types";
import { getProviderConfig } from "./config";

/**
 * Resolve the active vector store. Throws `rag-provider adapter not
 * wired: <provider>` until the real adapters land.
 */
export function getVectorStore(): VectorStore {
  const cfg = getProviderConfig();

  switch (cfg.vector) {
    case "qdrant":
      // TODO(azure-migration): wire qdrant-vector.ts (wraps the existing
      // src/lib/qdrant.ts client with the new VectorStore interface).
      throw new Error("rag-provider adapter not wired: qdrant");
    case "azure_ai_search":
      // TODO(azure-migration): wire azure-ai-search-vector.ts using
      // cfg.azureAiSearch (endpoint + apiKey + index + apiVersion).
      throw new Error("rag-provider adapter not wired: azure_ai_search");
    case "dual":
      // TODO(azure-migration): wire dual-vector.ts that fans out writes
      // to both adapters and reads from the primary (Qdrant), with a
      // shadow-compare path for diff telemetry.
      throw new Error("rag-provider adapter not wired: dual");
    default: {
      const _exhaustive: never = cfg.vector;
      throw new Error(`rag-provider adapter not wired: ${_exhaustive as string}`);
    }
  }
}

/**
 * Resolve the active embedding provider.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const cfg = getProviderConfig();

  switch (cfg.embedding) {
    case "openai":
      // TODO(azure-migration): wire openai-embeddings.ts (text-embedding-3-*).
      throw new Error("rag-provider adapter not wired: openai");
    case "azure_openai":
      // TODO(azure-migration): wire azure-openai-embeddings.ts against
      // cfg.azureOpenAI (deployment-name routing, not model-name).
      throw new Error("rag-provider adapter not wired: azure_openai");
    default: {
      const _exhaustive: never = cfg.embedding;
      throw new Error(`rag-provider adapter not wired: ${_exhaustive as string}`);
    }
  }
}

/**
 * Resolve the active graph store.
 */
export function getGraphStore(): GraphStore {
  const cfg = getProviderConfig();

  switch (cfg.graph) {
    case "neo4j":
      // TODO(azure-migration): wire neo4j-graph.ts (wraps src/lib/neo4j.ts).
      throw new Error("rag-provider adapter not wired: neo4j");
    case "age":
      // TODO(azure-migration): wire age-graph.ts (Postgres + AGE Cypher
      // via `cypher('graph_name', $$ MATCH ... $$)`).
      throw new Error("rag-provider adapter not wired: age");
    case "dual":
      // TODO(azure-migration): wire dual-graph.ts (mirror writes).
      throw new Error("rag-provider adapter not wired: dual");
    default: {
      const _exhaustive: never = cfg.graph;
      throw new Error(`rag-provider adapter not wired: ${_exhaustive as string}`);
    }
  }
}
