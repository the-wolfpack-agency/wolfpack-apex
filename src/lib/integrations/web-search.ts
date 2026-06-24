/**
 * Web search integration - provider-abstracted, env-gated, no SDK.
 *
 * Gives agents a real "scan the internet for X" capability. Before this, that
 * phrasing had no handler and mis-routed to create_crm_record; the web_search
 * operation (src/lib/agents/operations/registry.ts) now points at /api/web-search,
 * which calls searchWeb() here.
 *
 * Strategy (mirrors src/lib/brain/embedder.ts + src/lib/ai/models/registry.ts):
 *   - A small frozen PROVIDER registry, each entry env-gated by its own key.
 *     Adding, repricing-the-shape-of, or retiring a provider is a single edit
 *     here, never a call-site refactor (provider agility).
 *   - Each provider does a raw `fetch` (global fetch, like embedder.ts uses for
 *     OpenAI) - NO third-party SDK, NO new npm dependency.
 *   - We read only the PRESENCE of env-var keys to decide availability; the key
 *     VALUE is sent to the provider in the request and is NEVER logged.
 *
 * SECURITY:
 *   - No SSRF: every provider hits a single hard-coded provider endpoint. We
 *     never fetch a user-supplied URL - only the query string is forwarded.
 *   - Keys are never logged. Error strings are the provider name + HTTP status,
 *     never the key or the raw response body containing it.
 *
 * Graceful degradation: searchWeb NEVER throws. A provider error, an empty
 * query, or no-provider-configured all return a clean WebSearchResponse with
 * ok:false so an agent operation gets an inspectable result, never a 5xx.
 *
 * Provider comparison (recommended defaults: Brave, then Tavily):
 *   - brave   - BRAVE_SEARCH_API_KEY. Independent index, privacy-first, simple
 *               GET API, generous free tier. RECOMMENDED DEFAULT.
 *   - tavily  - TAVILY_API_KEY. LLM/agent-oriented search (POST), returns clean
 *               snippets well-suited to summarization. RECOMMENDED FALLBACK.
 *   - bing    - BING_SEARCH_KEY. Broad coverage, but Microsoft is RETIRING the
 *               Bing Search API (Azure marketplace deprecation), so it is NOT a
 *               default; kept in the registry only so an existing key can be
 *               used by setting BING_SEARCH_KEY. Prefer Brave/Tavily for new
 *               deploys.
 * The registry hard-codes none as "the" provider: searchWeb picks the FIRST
 * configured provider in registry order, so the active provider is chosen purely
 * by which key is present in the environment.
 */

/** One normalized search hit. The shape every provider maps onto. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** The always-returned envelope. `ok` carries success/not-configured/error. */
export interface WebSearchResponse {
  ok: boolean;
  /** The provider that served (or would have served) the request; "none" when
   *  no provider is configured. */
  provider: string;
  results: WebSearchResult[];
  /** Present only when ok is false: a short, key-free reason. */
  error?: string;
}

/** Default + maximum number of results we ask a provider for / return. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** A registered search provider. `search` does the raw fetch + maps to the
 *  normalized WebSearchResult[]. It may throw; searchWeb wraps every call. */
interface SearchProvider {
  /** Stable provider id, surfaced in WebSearchResponse.provider + analytics. */
  name: string;
  /** Env var holding this provider's API key. Presence => configured. */
  envKey: string;
  /** Run the search. `key` is the resolved env value (never logged here). */
  search(query: string, limit: number, key: string): Promise<WebSearchResult[]>;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * The provider registry. Frozen so it cannot be mutated at runtime (parity with
 * MODEL_REGISTRY). Order is intentional: Brave first, Tavily second (the two
 * recommended defaults), Bing last (retiring - usable only if its key is set).
 */
export const SEARCH_PROVIDERS: readonly SearchProvider[] = Object.freeze([
  {
    name: "brave",
    envKey: "BRAVE_SEARCH_API_KEY",
    async search(query, limit, key) {
      const url =
        "https://api.search.brave.com/res/v1/web/search?q=" +
        encodeURIComponent(query) +
        "&count=" +
        clampLimit(limit);
      const res = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": key,
        },
      });
      if (!res.ok) {
        throw new Error(`brave search HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      const rows = body.web?.results ?? [];
      return rows.map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.description),
      }));
    },
  },
  {
    name: "tavily",
    envKey: "TAVILY_API_KEY",
    async search(query, limit, key) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: clampLimit(limit),
        }),
      });
      if (!res.ok) {
        throw new Error(`tavily search HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        results?: { title?: string; url?: string; content?: string }[];
      };
      const rows = body.results ?? [];
      return rows.map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.content),
      }));
    },
  },
  {
    name: "bing",
    envKey: "BING_SEARCH_KEY",
    async search(query, limit, key) {
      // NOTE: Microsoft is retiring the Bing Search API. Kept only so an existing
      // key keeps working; Brave/Tavily are the recommended defaults.
      const url =
        "https://api.bing.microsoft.com/v7.0/search?q=" +
        encodeURIComponent(query) +
        "&count=" +
        clampLimit(limit);
      const res = await fetch(url, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": key },
      });
      if (!res.ok) {
        throw new Error(`bing search HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        webPages?: { value?: { name?: string; url?: string; snippet?: string }[] };
      };
      const rows = body.webPages?.value ?? [];
      return rows.map((r) => ({
        title: str(r.name),
        url: str(r.url),
        snippet: str(r.snippet),
      }));
    },
  },
]);

/** Has a value (non-empty string). Mirrors the model registry's hasValue. */
function hasValue(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

/**
 * Whether ANY web-search provider is configured in the given environment.
 * Pure: reads only env-var presence (never values), never the network.
 * `env` is injectable so tests stay hermetic.
 */
export function isWebSearchConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return SEARCH_PROVIDERS.some((p) => hasValue(env[p.envKey]));
}

/**
 * Run a web search. Picks the FIRST configured provider in registry order,
 * calls it, and maps to a normalized WebSearchResult[] (capped at `limit`,
 * default 5). NEVER throws:
 *   - empty/blank query        -> { ok:false, provider:"none", error:"query is required" }
 *   - no provider configured   -> { ok:false, provider:"none", error:"web search is not configured" }
 *   - provider call failed     -> { ok:false, provider:<name>, error:<short reason> }
 *   - success                  -> { ok:true,  provider:<name>, results }
 *
 * `env` is injectable for hermetic tests.
 */
export async function searchWeb(
  query: string,
  opts: { limit?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebSearchResponse> {
  const q = (query ?? "").trim();
  if (!q) {
    return { ok: false, provider: "none", results: [], error: "query is required" };
  }

  const provider = SEARCH_PROVIDERS.find((p) => hasValue(env[p.envKey]));
  if (!provider) {
    return {
      ok: false,
      provider: "none",
      results: [],
      error: "web search is not configured",
    };
  }

  const limit = clampLimit(opts.limit ?? DEFAULT_LIMIT);
  const key = env[provider.envKey] as string;

  try {
    const results = await provider.search(q, limit, key);
    return {
      ok: true,
      provider: provider.name,
      results: results.slice(0, limit),
    };
  } catch (err) {
    // Surface a short, key-free reason. We deliberately do NOT log the key or
    // the raw provider body (it can echo the key back).
    const message = err instanceof Error ? err.message : "web search failed";
    return { ok: false, provider: provider.name, results: [], error: message };
  }
}
