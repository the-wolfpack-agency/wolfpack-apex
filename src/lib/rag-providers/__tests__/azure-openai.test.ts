/**
 * azure-openai.test.ts
 *
 * Covers the Azure OpenAI embedding adapter:
 *   - URL/header/body shape
 *   - empty input short-circuit
 *   - network failure + non-2xx handling (never throws, returns [])
 *   - analytics events (`rag.embedding_ok` / `rag.embedding_failed`)
 *   - lazy dimensions caching from first successful response
 *   - out-of-order response index re-sorting
 *   - health() ok + failed paths
 */



jest.mock("@/lib/rag-providers/analytics-shim", () => ({
  emitRagEvent: jest.fn().mockResolvedValue(undefined),
}));

// The types module is being written in parallel; stub it so this suite is self-contained.
jest.mock(
  "@/lib/rag-providers/types",
  () => ({}),
  { virtual: true }
);

import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";
import { createAzureOpenAIEmbedder } from "@/lib/rag-providers/azure-openai";

const mockEmit = emitRagEvent as jest.MockedFunction<typeof emitRagEvent>;

const CFG = {
  endpoint: "https://example-azure.openai.azure.com",
  apiKey: "test-key-xyz",
  deployment: "text-embedding-3-small",
  apiVersion: "2024-02-15-preview",
};

function mockFetchOnce(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  const resp = {
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: jest.fn().mockResolvedValue(response.jsonBody ?? {}),
    text: jest.fn().mockResolvedValue(response.textBody ?? ""),
  };
  (global.fetch as jest.Mock).mockResolvedValueOnce(resp as unknown as Response);
  return resp;
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn() as unknown as typeof fetch;
});

/* ─────────────────── embed() ─────────────────── */

describe("createAzureOpenAIEmbedder.embed", () => {
  test("happy path: correct URL/body/header, returns embeddings in index order, emits _ok", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: {
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 0 },
          { embedding: [0.4, 0.5, 0.6], index: 1 },
        ],
      },
    });

    const emb = createAzureOpenAIEmbedder(CFG);
    const out = await emb.embed(["hello", "world"]);

    expect(out).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe(
      "https://example-azure.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-02-15-preview"
    );
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers["api-key"]).toBe("test-key-xyz");
    expect(calledInit.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calledInit.body)).toEqual({ input: ["hello", "world"] });

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [eventName, userId, role, meta] = mockEmit.mock.calls[0];
    expect(eventName).toBe("rag.embedding_ok");
    expect(userId).toBe("system");
    expect(role).toBe("system");
    expect(meta).toMatchObject({
      provider: "azure_openai",
      model: "text-embedding-3-small",
      input_count: 2,
    });
    expect(typeof (meta as { duration_ms: number }).duration_ms).toBe("number");
  });

  test("empty array: no fetch, returns [], no event emitted", async () => {
    const emb = createAzureOpenAIEmbedder(CFG);
    const out = await emb.embed([]);
    expect(out).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test("network failure: returns [], emits _failed with error detail", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("ECONNRESET"));
    const emb = createAzureOpenAIEmbedder(CFG);
    const out = await emb.embed(["x"]);
    expect(out).toEqual([]);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [eventName, , , meta] = mockEmit.mock.calls[0];
    expect(eventName).toBe("rag.embedding_failed");
    expect(meta).toMatchObject({
      provider: "azure_openai",
      model: "text-embedding-3-small",
      input_count: 1,
    });
    expect((meta as { error: string }).error).toMatch(/ECONNRESET/);
  });

  /* A 429 IS NOW RETRIED ONCE BEFORE IT COUNTS AS A FAILURE.
   *
   * This asserted that a single 429 returned [] and reported a failure, which
   * was the behavior and was the bug. Measured over 90 days of production:
   * 178 of these, each one silently dropping the Brain to keyword-only with
   * nobody told. The request was fine; the service was busy.
   *
   * So the contract moved: one throttle is survived, two is a failure. The
   * test moved with it rather than being loosened. */
  test("a single 429 is retried, so a throttle does not halve the search", async () => {
    mockFetchOnce({ ok: false, status: 429, textBody: "Too Many Requests" });
    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: { data: [{ embedding: [1, 1, 1], index: 0 }] },
    });
    const out = await createAzureOpenAIEmbedder(CFG).embed(["a"]);
    expect(out).toEqual([[1, 1, 1]]);
    /* Recovered, so nothing is reported as FAILED. The success event still
       fires: a retry that worked is still a call that happened. */
    expect(mockEmit.mock.calls.map((c) => c[0])).not.toContain("rag.embedding_failed");
  });

  test("429 twice: returns [], emits _failed with HTTP status detail", async () => {
    mockFetchOnce({ ok: false, status: 429, textBody: "Too Many Requests — retry after 30s" });
    mockFetchOnce({ ok: false, status: 429, textBody: "Too Many Requests — retry after 30s" });
    const emb = createAzureOpenAIEmbedder(CFG);
    const out = await emb.embed(["a", "b"]);
    expect(out).toEqual([]);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [eventName, , , meta] = mockEmit.mock.calls[0];
    expect(eventName).toBe("rag.embedding_failed");
    expect((meta as { error: string }).error).toMatch(/HTTP 429/);
    expect((meta as { error: string }).error).toMatch(/Too Many Requests/);
    /* Named, so a throttle that survived a retry is distinguishable from a
       first-try failure when somebody reads these later. */
    expect((meta as { retried: boolean }).retried).toBe(true);
  });

  test("out-of-order response indices are re-sorted in returned array", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: {
        data: [
          { embedding: [9, 9, 9], index: 1 },
          { embedding: [1, 1, 1], index: 0 },
        ],
      },
    });
    const emb = createAzureOpenAIEmbedder(CFG);
    const out = await emb.embed(["first", "second"]);
    expect(out).toEqual([
      [1, 1, 1],
      [9, 9, 9],
    ]);
  });

  test("uses default apiVersion when cfg.apiVersion omitted", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: { data: [{ embedding: [0.5], index: 0 }] },
    });
    const emb = createAzureOpenAIEmbedder({
      endpoint: "https://example-azure.openai.azure.com",
      apiKey: "k",
      deployment: "d",
    });
    await emb.embed(["ping"]);
    const [calledUrl] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toMatch(/api-version=2024-02-15-preview/);
  });
});

/* ─────────────────── dimensions caching ─────────────────── */

describe("dimensions caching", () => {
  test("null before first successful embed; cached to vector length after", async () => {
    const emb = createAzureOpenAIEmbedder(CFG);
    expect(emb.dimensions).toBeNull();

    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: {
        data: [{ embedding: new Array(1536).fill(0), index: 0 }],
      },
    });
    await emb.embed(["x"]);
    expect(emb.dimensions).toBe(1536);
  });

  test("dimensions reflects the actual vector length returned", async () => {
    const emb = createAzureOpenAIEmbedder(CFG);
    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] },
    });
    await emb.embed(["foo"]);
    expect(emb.dimensions).toBe(4);
  });

  test("dimensions stays null after a failed call", async () => {
    const emb = createAzureOpenAIEmbedder(CFG);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    await emb.embed(["x"]);
    expect(emb.dimensions).toBeNull();
  });
});

/* ─────────────────── health() ─────────────────── */

describe("health", () => {
  test("ok path: returns { ok: true } with latencyMs number", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      jsonBody: { data: [{ embedding: [0.1, 0.2], index: 0 }] },
    });
    const emb = createAzureOpenAIEmbedder(CFG);
    const h = await emb.health();
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("failed path: network error surfaces ok=false with detail", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("DNS failure"));
    const emb = createAzureOpenAIEmbedder(CFG);
    const h = await emb.health();
    expect(h.ok).toBe(false);
    expect(typeof h.latencyMs).toBe("number");
    // embed() swallowed the error and emitted _failed; health sees empty array
    expect(h.detail).toMatch(/no vectors/i);
  });

  test("failed path: non-2xx surfaces ok=false", async () => {
    mockFetchOnce({ ok: false, status: 500, textBody: "boom" });
    const emb = createAzureOpenAIEmbedder(CFG);
    const h = await emb.health();
    expect(h.ok).toBe(false);
    expect(typeof h.latencyMs).toBe("number");
  });
});

/* ─────────────────── provider identity ─────────────────── */

describe("provider identity", () => {
  test("exposes name='azure_openai' and model=deployment", () => {
    const emb = createAzureOpenAIEmbedder(CFG);
    expect(emb.name).toBe("azure_openai");
    expect(emb.model).toBe("text-embedding-3-small");
  });
});
