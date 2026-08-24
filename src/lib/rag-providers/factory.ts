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
import { createAzureOpenAIEmbedder } from "./azure-openai";

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
      // Still unwired, and deliberately so: this deployment runs Azure, and an
      // OpenAI adapter nobody uses is an untested path pretending to be a
      // fallback. It throws by name so the failure says which provider was
      // asked for.
      throw new Error("rag-provider adapter not wired: openai");
    case "azure_openai": {
      /* WIRED 2026-08-24. It had been a TODO that threw, next to a complete
         implementation in azure-openai.ts, while brain/embedder.ts went its own
         way to api.openai.com with a Bearer token. The result: 2,305 chunks
         across 779 documents with embedded=false, every one of them, and 252
         brain queries in 30 days with zero semantic hits. */
      if (!cfg.azureOpenAI) {
        throw new Error(
          "azure_openai embeddings selected but not configured: needs AZURE_OPENAI_ENDPOINT, " +
            "AZURE_OPENAI_API_KEY and AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
        );
      }
      return createAzureOpenAIEmbedder({
        endpoint: cfg.azureOpenAI.endpoint,
        apiKey: cfg.azureOpenAI.apiKey,
        deployment: cfg.azureOpenAI.embeddingDeployment,
      });
    }
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
