/**
 * web-search integration - provider abstraction, env gating, graceful
 * degradation. searchWeb NEVER throws; the ok flag carries the outcome.
 *
 * fetch is mocked per-provider so the tests are hermetic (no network) and assert
 * both provider SELECTION (by which env key is present) and result MAPPING (each
 * provider's distinct response shape -> the normalized WebSearchResult[]).
 */

import {
  isWebSearchConfigured,
  searchWeb,
  SEARCH_PROVIDERS,
} from "@/lib/integrations/web-search";

/** Build a hermetic env object typed as ProcessEnv for injection (mirrors the
 *  model-registry test helper). */
function env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function mockFetchOk(json: unknown): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("isWebSearchConfigured", () => {
  it("is false when no provider key is present", () => {
    expect(isWebSearchConfigured(env())).toBe(false);
  });

  it("is true when any single provider key is present", () => {
    expect(isWebSearchConfigured(env({ BRAVE_SEARCH_API_KEY: "k" }))).toBe(true);
    expect(isWebSearchConfigured(env({ TAVILY_API_KEY: "k" }))).toBe(true);
    expect(isWebSearchConfigured(env({ BING_SEARCH_KEY: "k" }))).toBe(true);
  });

  it("treats an empty-string key as not configured", () => {
    expect(isWebSearchConfigured(env({ BRAVE_SEARCH_API_KEY: "" }))).toBe(false);
  });
});

describe("registry", () => {
  it("registers brave, tavily, and bing, brave-first (recommended default)", () => {
    const names = SEARCH_PROVIDERS.map((p) => p.name);
    expect(names).toEqual(["brave", "tavily", "bing"]);
  });

  it("is frozen (cannot be mutated at runtime)", () => {
    expect(Object.isFrozen(SEARCH_PROVIDERS)).toBe(true);
  });
});

describe("searchWeb - validation", () => {
  it("rejects an empty/blank query without calling any provider", async () => {
    const fn = mockFetchOk({});
    const res = await searchWeb("   ", {}, env({ BRAVE_SEARCH_API_KEY: "k" }));
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("none");
    expect(res.error).toMatch(/query is required/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("searchWeb - not configured", () => {
  it("returns a clean not-configured result, never throws, no fetch", async () => {
    const fn = jest.fn();
    global.fetch = fn as unknown as typeof fetch;
    const res = await searchWeb("auto saas companies", {}, env());
    expect(res).toEqual({
      ok: false,
      provider: "none",
      results: [],
      error: "web search is not configured",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("searchWeb - provider selection + mapping", () => {
  it("uses brave and maps {title,url,description} when its key is set", async () => {
    const fn = mockFetchOk({
      web: {
        results: [
          { title: "T1", url: "https://a.com", description: "snip1" },
          { title: "T2", url: "https://b.com", description: "snip2" },
        ],
      },
    });
    const res = await searchWeb("x", {}, env({ BRAVE_SEARCH_API_KEY: "bk" }));
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("brave");
    expect(res.results).toEqual([
      { title: "T1", url: "https://a.com", snippet: "snip1" },
      { title: "T2", url: "https://b.com", snippet: "snip2" },
    ]);
    // Brave is a GET; the key rides in a header, never logged.
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("api.search.brave.com");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("uses tavily (POST, {content} snippet) when only its key is set", async () => {
    const fn = mockFetchOk({
      results: [{ title: "TT", url: "https://t.com", content: "tav snip" }],
    });
    const res = await searchWeb("x", {}, env({ TAVILY_API_KEY: "tk" }));
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("tavily");
    expect(res.results).toEqual([
      { title: "TT", url: "https://t.com", snippet: "tav snip" },
    ]);
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("api.tavily.com");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("uses bing ({name,snippet}) when only its key is set", async () => {
    mockFetchOk({
      webPages: {
        value: [{ name: "BN", url: "https://bing.com", snippet: "bing snip" }],
      },
    });
    const res = await searchWeb("x", {}, env({ BING_SEARCH_KEY: "bk" }));
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("bing");
    expect(res.results).toEqual([
      { title: "BN", url: "https://bing.com", snippet: "bing snip" },
    ]);
  });

  it("picks the FIRST configured provider in registry order (brave over tavily)", async () => {
    mockFetchOk({ web: { results: [] } });
    const res = await searchWeb(
      "x",
      {},
      env({ BRAVE_SEARCH_API_KEY: "bk", TAVILY_API_KEY: "tk" }),
    );
    expect(res.provider).toBe("brave");
  });

  it("caps results to the requested limit (default 5)", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `T${i}`,
      url: `https://x${i}.com`,
      description: "s",
    }));
    mockFetchOk({ web: { results: many } });
    const res = await searchWeb("x", {}, env({ BRAVE_SEARCH_API_KEY: "bk" }));
    expect(res.results).toHaveLength(5);

    mockFetchOk({ web: { results: many } });
    const res2 = await searchWeb("x", { limit: 3 }, env({ BRAVE_SEARCH_API_KEY: "bk" }));
    expect(res2.results).toHaveLength(3);
  });
});

describe("searchWeb - graceful provider errors (never throws)", () => {
  it("returns ok:false with the provider name on a non-2xx response", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limited",
    })) as unknown as typeof fetch;
    const res = await searchWeb("x", {}, env({ BRAVE_SEARCH_API_KEY: "bk" }));
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("brave");
    expect(res.results).toEqual([]);
    expect(res.error).toMatch(/429/);
    // The key must never leak into the error string.
    expect(res.error).not.toContain("bk");
  });

  it("returns ok:false when fetch itself rejects (network down)", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const res = await searchWeb("x", {}, env({ TAVILY_API_KEY: "tk" }));
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("tavily");
    expect(res.error).toMatch(/network unreachable/);
  });

  it("returns ok:false when the provider returns malformed JSON", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
      text: async () => "<<not json>>",
    })) as unknown as typeof fetch;
    const res = await searchWeb("x", {}, env({ BRAVE_SEARCH_API_KEY: "bk" }));
    expect(res.ok).toBe(false);
    expect(res.results).toEqual([]);
  });
});
