/**
 * rag-providers/config.ts
 *
 * Strictly-typed env reader for the provider-abstraction layer. Callers
 * should go through `getProviderConfig()` instead of touching
 * `process.env` directly — that keeps the "which adapter is live"
 * decision in exactly one place and makes misconfiguration loud at
 * call-time instead of silent at query-time.
 *
 * Rules enforced here:
 *   - env values are read case-insensitively (so `Qdrant` == `qdrant`)
 *   - unknown provider names throw immediately
 *   - if the user picks an Azure provider (or `"dual"`) but does not
 *     supply the credentials, this throws. No silent fallback — a
 *     half-configured dual-write is how data gets silently dropped.
 */

export type VectorProvider = "qdrant" | "azure_ai_search" | "dual";
export type GraphProvider = "neo4j" | "age" | "dual";
export type EmbeddingProviderName = "openai" | "azure_openai";

/** Azure AI Search connection config. Present only when selected. */
export interface AzureAiSearchConfig {
  endpoint: string;
  apiKey: string;
  index: string;
  apiVersion: string;
}

/** Azure OpenAI (embeddings) connection config. Present only when selected. */
export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  embeddingDeployment: string;
  apiVersion: string;
}

/** Full resolved provider config. `azureAiSearch`/`azureOpenAI` are
 *  populated exactly when the corresponding provider is active. */
export interface ProviderConfig {
  vector: VectorProvider;
  graph: GraphProvider;
  embedding: EmbeddingProviderName;
  azureAiSearch?: AzureAiSearchConfig;
  azureOpenAI?: AzureOpenAIConfig;
}

const DEFAULT_AZURE_AI_SEARCH_API_VERSION = "2024-07-01";
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-02-01";

/** Normalize an env var to lower-case, trimmed, or `undefined` if unset/empty. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readEnvLower(name: string): string | undefined {
  const v = readEnv(name);
  return v === undefined ? undefined : v.toLowerCase();
}

function parseVectorProvider(raw: string | undefined): VectorProvider {
  const v = (raw ?? "qdrant").toLowerCase();
  if (v === "qdrant" || v === "azure_ai_search" || v === "dual") return v;
  throw new Error(
    `INSTINCT_VECTOR_PROVIDER: invalid value "${raw}". Expected one of: qdrant | azure_ai_search | dual`,
  );
}

function parseGraphProvider(raw: string | undefined): GraphProvider {
  const v = (raw ?? "neo4j").toLowerCase();
  if (v === "neo4j" || v === "age" || v === "dual") return v;
  throw new Error(
    `INSTINCT_GRAPH_PROVIDER: invalid value "${raw}". Expected one of: neo4j | age | dual`,
  );
}

/**
 * Which provider to embed with when nobody said.
 *
 * This defaulted to "openai" regardless of what the deployment actually had.
 * Combined with a factory that threw a TODO, the result was that Instinct,
 * which runs on Azure and holds no OpenAI key at all, silently never embedded
 * anything: 2,305 chunks at embedded=false and 252 brain queries over 30 days
 * with zero semantic hits.
 *
 * A default that ignores the configuration is not a default, it is a guess.
 * The explicit setting still wins, and selecting a provider whose variables
 * are missing still throws rather than falling back, which is the rule this
 * file already had and was right about.
 */
function defaultEmbeddingProvider(): EmbeddingProviderName {
  const azureReady =
    readEnv("AZURE_OPENAI_ENDPOINT") &&
    readEnv("AZURE_OPENAI_API_KEY") &&
    readEnv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
  return azureReady ? "azure_openai" : "openai";
}

function parseEmbeddingProvider(raw: string | undefined): EmbeddingProviderName {
  const v = (raw ?? defaultEmbeddingProvider()).toLowerCase();
  if (v === "openai" || v === "azure_openai") return v;
  throw new Error(
    `INSTINCT_EMBEDDING_PROVIDER: invalid value "${raw}". Expected one of: openai | azure_openai`,
  );
}

function loadAzureAiSearchConfig(): AzureAiSearchConfig {
  const endpoint = readEnv("AZURE_AI_SEARCH_ENDPOINT");
  const apiKey = readEnv("AZURE_AI_SEARCH_API_KEY");
  const index = readEnv("AZURE_AI_SEARCH_INDEX");
  const apiVersion = readEnv("AZURE_AI_SEARCH_API_VERSION") ?? DEFAULT_AZURE_AI_SEARCH_API_VERSION;

  const missing: string[] = [];
  if (!endpoint) missing.push("AZURE_AI_SEARCH_ENDPOINT");
  if (!apiKey) missing.push("AZURE_AI_SEARCH_API_KEY");
  if (!index) missing.push("AZURE_AI_SEARCH_INDEX");
  if (missing.length > 0) {
    throw new Error(
      `Azure AI Search selected (INSTINCT_VECTOR_PROVIDER) but missing required env vars: ${missing.join(", ")}. No silent fallback.`,
    );
  }

  return {
    endpoint: endpoint as string,
    apiKey: apiKey as string,
    index: index as string,
    apiVersion,
  };
}

function loadAzureOpenAIConfig(): AzureOpenAIConfig {
  const endpoint = readEnv("AZURE_OPENAI_ENDPOINT");
  const apiKey = readEnv("AZURE_OPENAI_API_KEY");
  const embeddingDeployment = readEnv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
  const apiVersion = readEnv("AZURE_OPENAI_API_VERSION") ?? DEFAULT_AZURE_OPENAI_API_VERSION;

  const missing: string[] = [];
  if (!endpoint) missing.push("AZURE_OPENAI_ENDPOINT");
  if (!apiKey) missing.push("AZURE_OPENAI_API_KEY");
  if (!embeddingDeployment) missing.push("AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
  if (missing.length > 0) {
    throw new Error(
      `Azure OpenAI selected (INSTINCT_EMBEDDING_PROVIDER=azure_openai) but missing required env vars: ${missing.join(", ")}. No silent fallback.`,
    );
  }

  return {
    endpoint: endpoint as string,
    apiKey: apiKey as string,
    embeddingDeployment: embeddingDeployment as string,
    apiVersion,
  };
}

/**
 * Validate that the Postgres side of AGE is at least *nominally*
 * reachable. We don't connect here — that's the adapter's job — but we
 * refuse the `age`/`dual` graph provider without a DATABASE_URL, which
 * is the surface-level symptom of a half-configured install.
 */
function assertAgeReady(): void {
  const dbUrl = readEnv("DATABASE_URL");
  if (!dbUrl) {
    throw new Error(
      "Apache AGE graph provider selected (INSTINCT_GRAPH_PROVIDER) but DATABASE_URL is not set. AGE requires a Postgres connection. No silent fallback.",
    );
  }
}

/**
 * Resolve the provider configuration from env. Throws on any
 * misconfiguration; callers should treat a throw as boot-fatal.
 */
export function getProviderConfig(): ProviderConfig {
  const vector = parseVectorProvider(readEnvLower("INSTINCT_VECTOR_PROVIDER"));
  const graph = parseGraphProvider(readEnvLower("INSTINCT_GRAPH_PROVIDER"));
  const embedding = parseEmbeddingProvider(readEnvLower("INSTINCT_EMBEDDING_PROVIDER"));

  const cfg: ProviderConfig = { vector, graph, embedding };

  if (vector === "azure_ai_search" || vector === "dual") {
    cfg.azureAiSearch = loadAzureAiSearchConfig();
  }

  if (embedding === "azure_openai") {
    cfg.azureOpenAI = loadAzureOpenAIConfig();
  }

  if (graph === "age" || graph === "dual") {
    assertAgeReady();
  }

  return cfg;
}
