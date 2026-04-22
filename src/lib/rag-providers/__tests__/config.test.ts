/**
 * config.test.ts
 *
 * Covers getProviderConfig():
 *   - default values when env unset
 *   - every valid provider value for each knob
 *   - case-insensitive env reads
 *   - azure_ai_search / azure_openai / age require creds — no silent fallback
 *   - dual vector requires Azure creds (it's azure + the other)
 *   - dual graph requires DATABASE_URL (for AGE side)
 *   - invalid provider names throw
 */

import { getProviderConfig } from "@/lib/rag-providers/config";

const AZURE_SEARCH_KEYS = [
  "AZURE_AI_SEARCH_ENDPOINT",
  "AZURE_AI_SEARCH_API_KEY",
  "AZURE_AI_SEARCH_INDEX",
  "AZURE_AI_SEARCH_API_VERSION",
];
const AZURE_OPENAI_KEYS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
];
const PROVIDER_KEYS = [
  "INSTINCT_VECTOR_PROVIDER",
  "INSTINCT_GRAPH_PROVIDER",
  "INSTINCT_EMBEDDING_PROVIDER",
];
const ALL_KEYS = [
  ...PROVIDER_KEYS,
  ...AZURE_SEARCH_KEYS,
  ...AZURE_OPENAI_KEYS,
  "DATABASE_URL",
];

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ALL_KEYS) ORIGINAL_ENV[k] = process.env[k];
});

beforeEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of ALL_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

function setAzureSearchEnv(): void {
  process.env.AZURE_AI_SEARCH_ENDPOINT = "https://contoso.search.windows.net";
  process.env.AZURE_AI_SEARCH_API_KEY = "k-abc";
  process.env.AZURE_AI_SEARCH_INDEX = "instinct-index";
}

function setAzureOpenAIEnv(): void {
  process.env.AZURE_OPENAI_ENDPOINT = "https://contoso.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "k-xyz";
  process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = "text-embedding-3-large";
}

describe("getProviderConfig() defaults", () => {
  test("returns qdrant + neo4j + openai when no env is set", () => {
    const cfg = getProviderConfig();
    expect(cfg.vector).toBe("qdrant");
    expect(cfg.graph).toBe("neo4j");
    expect(cfg.embedding).toBe("openai");
    expect(cfg.azureAiSearch).toBeUndefined();
    expect(cfg.azureOpenAI).toBeUndefined();
  });

  test("empty string env is treated as unset", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "";
    process.env.INSTINCT_GRAPH_PROVIDER = "   ";
    process.env.INSTINCT_EMBEDDING_PROVIDER = "";
    const cfg = getProviderConfig();
    expect(cfg.vector).toBe("qdrant");
    expect(cfg.graph).toBe("neo4j");
    expect(cfg.embedding).toBe("openai");
  });
});

describe("getProviderConfig() case-insensitive env reads", () => {
  test("accepts mixed-case provider names", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "Qdrant";
    process.env.INSTINCT_GRAPH_PROVIDER = "NEO4J";
    process.env.INSTINCT_EMBEDDING_PROVIDER = "OpenAI";
    const cfg = getProviderConfig();
    expect(cfg.vector).toBe("qdrant");
    expect(cfg.graph).toBe("neo4j");
    expect(cfg.embedding).toBe("openai");
  });

  test("accepts upper-case AZURE_* values", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "AZURE_AI_SEARCH";
    process.env.INSTINCT_EMBEDDING_PROVIDER = "AZURE_OPENAI";
    setAzureSearchEnv();
    setAzureOpenAIEnv();
    const cfg = getProviderConfig();
    expect(cfg.vector).toBe("azure_ai_search");
    expect(cfg.embedding).toBe("azure_openai");
  });
});

describe("getProviderConfig() valid provider combinations", () => {
  test("azure_ai_search vector + full azure creds resolves cleanly", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "azure_ai_search";
    setAzureSearchEnv();
    const cfg = getProviderConfig();
    expect(cfg.vector).toBe("azure_ai_search");
    expect(cfg.azureAiSearch).toBeDefined();
    expect(cfg.azureAiSearch?.endpoint).toBe("https://contoso.search.windows.net");
    expect(cfg.azureAiSearch?.apiKey).toBe("k-abc");
    expect(cfg.azureAiSearch?.index).toBe("instinct-index");
    // default api version
    expect(cfg.azureAiSearch?.apiVersion).toBe("2024-07-01");
  });

  test("custom AZURE_AI_SEARCH_API_VERSION overrides default", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "azure_ai_search";
    setAzureSearchEnv();
    process.env.AZURE_AI_SEARCH_API_VERSION = "2025-01-01-preview";
    const cfg = getProviderConfig();
    expect(cfg.azureAiSearch?.apiVersion).toBe("2025-01-01-preview");
  });

  test("azure_openai embedding + full creds resolves with default api version", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "azure_openai";
    setAzureOpenAIEnv();
    const cfg = getProviderConfig();
    expect(cfg.embedding).toBe("azure_openai");
    expect(cfg.azureOpenAI?.endpoint).toBe("https://contoso.openai.azure.com");
    expect(cfg.azureOpenAI?.embeddingDeployment).toBe("text-embedding-3-large");
    expect(cfg.azureOpenAI?.apiVersion).toBe("2024-02-01");
  });

  test("age graph with DATABASE_URL resolves", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "age";
    process.env.DATABASE_URL = "postgres://u:p@host:5432/db";
    const cfg = getProviderConfig();
    expect(cfg.graph).toBe("age");
  });

  test("dual vector requires BOTH Qdrant assumed-default AND Azure creds", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "dual";
    setAzureSearchEnv();
    const cfg = getProviderConfig();
    expect(cfg.vector).toBe("dual");
    expect(cfg.azureAiSearch).toBeDefined();
  });

  test("dual graph requires DATABASE_URL", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "dual";
    process.env.DATABASE_URL = "postgres://u:p@host:5432/db";
    const cfg = getProviderConfig();
    expect(cfg.graph).toBe("dual");
  });
});

describe("getProviderConfig() missing creds throw — no silent fallback", () => {
  test("azure_ai_search without endpoint throws", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "azure_ai_search";
    setAzureSearchEnv();
    delete process.env.AZURE_AI_SEARCH_ENDPOINT;
    expect(() => getProviderConfig()).toThrow(/AZURE_AI_SEARCH_ENDPOINT/);
    expect(() => getProviderConfig()).toThrow(/No silent fallback/);
  });

  test("azure_ai_search with zero creds lists all missing vars", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "azure_ai_search";
    expect(() => getProviderConfig()).toThrow(/AZURE_AI_SEARCH_ENDPOINT/);
    expect(() => getProviderConfig()).toThrow(/AZURE_AI_SEARCH_API_KEY/);
    expect(() => getProviderConfig()).toThrow(/AZURE_AI_SEARCH_INDEX/);
  });

  test("dual vector without Azure creds throws", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "dual";
    expect(() => getProviderConfig()).toThrow(/AZURE_AI_SEARCH_ENDPOINT/);
  });

  test("azure_openai without api key throws", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "azure_openai";
    setAzureOpenAIEnv();
    delete process.env.AZURE_OPENAI_API_KEY;
    expect(() => getProviderConfig()).toThrow(/AZURE_OPENAI_API_KEY/);
    expect(() => getProviderConfig()).toThrow(/No silent fallback/);
  });

  test("azure_openai without deployment throws", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "azure_openai";
    setAzureOpenAIEnv();
    delete process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
    expect(() => getProviderConfig()).toThrow(/AZURE_OPENAI_EMBEDDING_DEPLOYMENT/);
  });

  test("age graph without DATABASE_URL throws", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "age";
    expect(() => getProviderConfig()).toThrow(/DATABASE_URL/);
    expect(() => getProviderConfig()).toThrow(/No silent fallback/);
  });

  test("dual graph without DATABASE_URL throws", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "dual";
    expect(() => getProviderConfig()).toThrow(/DATABASE_URL/);
  });
});

describe("getProviderConfig() invalid values throw", () => {
  test("unknown vector provider throws with helpful list", () => {
    process.env.INSTINCT_VECTOR_PROVIDER = "pinecone";
    expect(() => getProviderConfig()).toThrow(/INSTINCT_VECTOR_PROVIDER/);
    expect(() => getProviderConfig()).toThrow(/qdrant \| azure_ai_search \| dual/);
  });

  test("unknown graph provider throws", () => {
    process.env.INSTINCT_GRAPH_PROVIDER = "dgraph";
    expect(() => getProviderConfig()).toThrow(/INSTINCT_GRAPH_PROVIDER/);
  });

  test("unknown embedding provider throws", () => {
    process.env.INSTINCT_EMBEDDING_PROVIDER = "cohere";
    expect(() => getProviderConfig()).toThrow(/INSTINCT_EMBEDDING_PROVIDER/);
  });
});

export {};
