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

describe("getEmbeddingProvider() — not wired state", () => {
  test("throws 'not wired: openai' on default env", () => {
    expect(() => getEmbeddingProvider()).toThrow(/rag-provider adapter not wired: openai/);
  });

  test("throws 'not wired: azure_openai' with full creds", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "azure_openai";
    process.env.AZURE_OPENAI_ENDPOINT = "https://x.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "k";
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = "emb";
    expect(() => getEmbeddingProvider()).toThrow(/rag-provider adapter not wired: azure_openai/);
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
