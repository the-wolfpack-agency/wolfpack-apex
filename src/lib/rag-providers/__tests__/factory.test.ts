/**
 * factory.test.ts
 *
 * Covers factory.ts in its "not wired" foundation state. When adapters
 * land, these tests flip from "throws 'not wired'" to "returns the
 * correct instance"; the test names stay the same.
 */

import {
  getEmbeddingProvider,
  getGraphStore,
  getVectorStore,
} from "@/lib/rag-providers/factory";

const PROVIDER_KEYS = [
  "INSTINCT_VECTOR_PROVIDER",
  "INSTINCT_GRAPH_PROVIDER",
  "INSTINCT_EMBEDDING_PROVIDER",
  "AZURE_AI_SEARCH_ENDPOINT",
  "AZURE_AI_SEARCH_API_KEY",
  "AZURE_AI_SEARCH_INDEX",
  "AZURE_AI_SEARCH_API_VERSION",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
  "DATABASE_URL",
];

const ORIG: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of PROVIDER_KEYS) ORIG[k] = process.env[k];
});

beforeEach(() => {
  for (const k of PROVIDER_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of PROVIDER_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

describe("getVectorStore() — not wired state", () => {
  test("throws 'not wired: qdrant' on default env", () => {
    expect(() => getVectorStore()).toThrow(/rag-provider adapter not wired: qdrant/);
  });

  test("throws 'not wired: azure_ai_search' with full azure creds", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "azure_ai_search";
    process.env.AZURE_AI_SEARCH_ENDPOINT = "https://x.search.windows.net";
    process.env.AZURE_AI_SEARCH_API_KEY = "k";
    process.env.AZURE_AI_SEARCH_INDEX = "i";
    expect(() => getVectorStore()).toThrow(/rag-provider adapter not wired: azure_ai_search/);
  });

  test("throws 'not wired: dual' with full azure creds", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "dual";
    process.env.AZURE_AI_SEARCH_ENDPOINT = "https://x.search.windows.net";
    process.env.AZURE_AI_SEARCH_API_KEY = "k";
    process.env.AZURE_AI_SEARCH_INDEX = "i";
    expect(() => getVectorStore()).toThrow(/rag-provider adapter not wired: dual/);
  });

  test("misconfigured azure bubbles the config error, not the factory error", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "azure_ai_search";
    // no creds -> config throws first
    expect(() => getVectorStore()).toThrow(/AZURE_AI_SEARCH/);
  });
});

describe("getEmbeddingProvider()", () => {
  test("throws 'not wired: openai' on default env", () => {
    expect(() => getEmbeddingProvider()).toThrow(/rag-provider adapter not wired: openai/);
  });

  /* WIRED 2026-08-24. This test pinned the TODO, and the TODO was the bug: a
     complete Azure embedder sat unused in azure-openai.ts while the factory
     threw, so Instinct embedded nothing for the life of the feature. 2,305
     chunks at embedded=false, 252 brain queries in 30 days, zero semantic
     hits. Asserting that a thing is unwired keeps it unwired. */
  test("returns a real Azure embedder with full creds", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "azure_openai";
    process.env.AZURE_OPENAI_ENDPOINT = "https://x.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "k";
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = "emb";
    const provider = getEmbeddingProvider();
    expect(provider.name).toBe("azure_openai");
    expect(provider.model).toBe("emb");
    expect(typeof provider.embed).toBe("function");
  });

  test("selecting azure without a deployment name still refuses, with no silent fallback", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "azure_openai";
    process.env.AZURE_OPENAI_ENDPOINT = "https://x.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "k";
    delete process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
    expect(() => getEmbeddingProvider()).toThrow(/AZURE_OPENAI_EMBEDDING_DEPLOYMENT/);
  });
});

describe("getGraphStore() — not wired state", () => {
  test("throws 'not wired: neo4j' on default env", () => {
    expect(() => getGraphStore()).toThrow(/rag-provider adapter not wired: neo4j/);
  });

  test("throws 'not wired: age' with DATABASE_URL set", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "age";
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    expect(() => getGraphStore()).toThrow(/rag-provider adapter not wired: age/);
  });

  test("throws 'not wired: dual' with DATABASE_URL set", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "dual";
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    expect(() => getGraphStore()).toThrow(/rag-provider adapter not wired: dual/);
  });
});

export {};
