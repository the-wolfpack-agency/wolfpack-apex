/**
 * azure-ai-search.test.ts
 *
 * Covers the Azure AI Search VectorStore adapter:
 *   - upsert happy path: correct URL, mergeOrUpload action, emits rag.vector_upsert_ok
 *   - upsert HTTP 500: returns { written: 0 }, emits _failed
 *   - upsert network throw: same failure contract
 *   - search hybrid: body has BOTH vectorQueries AND search
 *   - search semantic: body has queryType + semanticConfiguration
 *   - search ALWAYS injects tenant_id into filter
 *   - search failure returns []
 *   - delete fires correct @search.action
 *   - health ok / 404
 *
 * fetch is mocked per test via jest.spyOn on global.fetch.
 * emitRagEvent is mocked at the module boundary so we can assert events.
 */

jest.mock("@/lib/rag-providers/analytics-shim", () => ({
  emitRagEvent: jest.fn(),
}));

// The sibling agent is writing types.ts. The adapter only imports types from
// that module (no runtime values), so ts-jest elides the import and the file
// doesn't need to exist at runtime for these tests.
import { createAzureAiSearchStore } from "@/lib/rag-providers/azure-ai-search";
import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";

const mockEmit = emitRagEvent as jest.MockedFunction<typeof emitRagEvent>;

const CFG = {
  endpoint: "https://example.search.windows.net",
  apiKey: "test-api-key",
  index: "docs",
  apiVersion: "2024-07-01",
};

function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errResponse(status: number, bodyText = "boom"): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: bodyText }),
    text: async () => bodyText,
  } as unknown as Response;
}

function mockFetchOnce(res: Response | Error): jest.SpyInstance {
  const impl =
    res instanceof Error
      ? jest.fn().mockRejectedValue(res)
      : jest.fn().mockResolvedValue(res);
  return jest.spyOn(global, "fetch").mockImplementation(impl as never);
}

function lastFetchCall(spy: jest.SpyInstance): { url: string; init: RequestInit } {
  const [url, init] = spy.mock.calls[spy.mock.calls.length - 1] as [
    string,
    RequestInit,
  ];
  return { url, init };
}

function parseBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ─────────────────────── upsert ─────────────────────── */

describe("createAzureAiSearchStore.upsert", () => {
  test("happy path: POSTs mergeOrUpload to /docs/index and emits rag.vector_upsert_ok", async () => {
    const spy = mockFetchOnce(okJson({ value: [{ status: true }] }));
    const store = createAzureAiSearchStore(CFG);

    const result = await store.upsert([
      {
        id: "doc-1",
        text: "hello",
        embedding: [0.1, 0.2],
        tenantId: "tenant-a",
        metadata: { source: "manual" },
      },
    ]);

    expect(result).toEqual({ written: 1 });
    expect(spy).toHaveBeenCalledTimes(1);

    const { url, init } = lastFetchCall(spy);
    expect(url).toBe(
      "https://example.search.windows.net/indexes/docs/docs/index?api-version=2024-07-01",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("test-api-key");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    const body = parseBody(init) as { value: Array<Record<string, unknown>> };
    expect(body.value).toHaveLength(1);
    expect(body.value[0]).toMatchObject({
      "@search.action": "mergeOrUpload",
      id: "doc-1",
      text: "hello",
      embedding: [0.1, 0.2],
      tenant_id: "tenant-a",
      source: "manual",
    });

    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_upsert_ok",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        doc_count: 1,
        duration_ms: expect.any(Number),
      }),
    );
  });

  test("HTTP 500: returns { written: 0 } and emits rag.vector_upsert_failed", async () => {
    mockFetchOnce(errResponse(500, "indexer broke"));
    const store = createAzureAiSearchStore(CFG);

    const result = await store.upsert([
      { id: "d1", text: "x", tenantId: "t", metadata: {} },
    ]);

    expect(result).toEqual({ written: 0 });
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_upsert_failed",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        error: expect.stringMatching(/500/),
      }),
    );
  });

  test("network throw: returns { written: 0 } and emits rag.vector_upsert_failed", async () => {
    mockFetchOnce(new Error("ECONNREFUSED"));
    const store = createAzureAiSearchStore(CFG);

    const result = await store.upsert([
      { id: "d1", text: "x", tenantId: "t", metadata: {} },
    ]);

    expect(result).toEqual({ written: 0 });
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_upsert_failed",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        error: expect.stringContaining("ECONNREFUSED"),
      }),
    );
  });
});

/* ─────────────────────── search ─────────────────────── */

describe("createAzureAiSearchStore.search", () => {
  test("hybrid mode: body contains BOTH vectorQueries AND search", async () => {
    const spy = mockFetchOnce(
      okJson({
        value: [
          { id: "d1", text: "hit", "@search.score": 0.9, source: "kb" },
        ],
      }),
    );
    const store = createAzureAiSearchStore(CFG);

    const hits = await store.search({
      query: "what is raggi",
      queryEmbedding: [0.3, 0.4],
      tenantId: "tenant-a",
      topK: 5,
      mode: "hybrid",
    });

    expect(hits).toEqual([
      {
        id: "d1",
        text: "hit",
        score: 0.9,
        metadata: { source: "kb" },
      },
    ]);

    const { url, init } = lastFetchCall(spy);
    expect(url).toContain("/indexes/docs/docs/search");
    const body = parseBody(init) as Record<string, unknown>;
    expect(body.vectorQueries).toEqual([
      { kind: "vector", vector: [0.3, 0.4], fields: "embedding", k: 5 },
    ]);
    expect(body.search).toBe("what is raggi");
    expect(body.queryType).toBeUndefined();

    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_query_ok",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        hit_count: 1,
        mode: "hybrid",
      }),
    );
  });

  test("semantic mode: body has queryType='semantic' and semanticConfiguration='default'", async () => {
    const spy = mockFetchOnce(okJson({ value: [] }));
    const store = createAzureAiSearchStore(CFG);

    await store.search({
      query: "q",
      queryEmbedding: [0.1],
      tenantId: "tenant-a",
      mode: "semantic",
    });

    const { init } = lastFetchCall(spy);
    const body = parseBody(init) as Record<string, unknown>;
    expect(body.queryType).toBe("semantic");
    expect(body.semanticConfiguration).toBe("default");
    expect(body.vectorQueries).toBeDefined();
    expect(body.search).toBe("q");
  });

  test("ALWAYS injects tenant_id filter — caller cannot bypass", async () => {
    const spy = mockFetchOnce(okJson({ value: [] }));
    const store = createAzureAiSearchStore(CFG);

    // Caller supplies no filter at all
    await store.search({
      query: "q",
      queryEmbedding: [0.1],
      tenantId: "tenant-xyz",
      mode: "vector",
    });
    let { init } = lastFetchCall(spy);
    let body = parseBody(init) as { filter: string };
    expect(body.filter).toContain("tenant_id eq 'tenant-xyz'");

    // Caller supplies an unrelated filter — tenant_id still injected and ANDed
    const spy2 = mockFetchOnce(okJson({ value: [] }));
    await store.search({
      query: "q",
      queryEmbedding: [0.1],
      tenantId: "tenant-xyz",
      mode: "keyword",
      filter: { category: "policy" },
    });
    ({ init } = lastFetchCall(spy2));
    body = parseBody(init) as { filter: string };
    expect(body.filter).toContain("tenant_id eq 'tenant-xyz'");
    expect(body.filter).toContain("category eq 'policy'");
    expect(body.filter).toContain(" and ");
  });

  test("keyword mode: no vectorQueries, just search", async () => {
    const spy = mockFetchOnce(okJson({ value: [] }));
    const store = createAzureAiSearchStore(CFG);

    await store.search({
      query: "just text",
      tenantId: "t",
      mode: "keyword",
    });

    const { init } = lastFetchCall(spy);
    const body = parseBody(init) as Record<string, unknown>;
    expect(body.search).toBe("just text");
    expect(body.vectorQueries).toBeUndefined();
  });

  test("failure returns [] and emits rag.vector_query_failed", async () => {
    mockFetchOnce(errResponse(503, "service busy"));
    const store = createAzureAiSearchStore(CFG);

    const hits = await store.search({
      query: "q",
      queryEmbedding: [0.1],
      tenantId: "t",
      mode: "hybrid",
    });

    expect(hits).toEqual([]);
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_query_failed",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        error: expect.stringMatching(/503/),
        mode: "hybrid",
      }),
    );
  });

  test("vector mode without queryEmbedding fails gracefully (returns [])", async () => {
    mockFetchOnce(okJson({ value: [] })); // should not be reached
    const store = createAzureAiSearchStore(CFG);

    const hits = await store.search({
      query: "q",
      tenantId: "t",
      mode: "vector",
    });

    expect(hits).toEqual([]);
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_query_failed",
      "system",
      "system",
      expect.objectContaining({ provider: "azure_ai_search" }),
    );
  });
});

/* ─────────────────────── delete ─────────────────────── */

describe("createAzureAiSearchStore.delete", () => {
  test("fires @search.action='delete' for each id and emits rag.vector_delete_ok", async () => {
    const spy = mockFetchOnce(okJson({ value: [{ status: true }] }));
    const store = createAzureAiSearchStore(CFG);

    const result = await store.delete(["a", "b"], "tenant-a");

    expect(result).toEqual({ deleted: 2 });
    const { url, init } = lastFetchCall(spy);
    expect(url).toContain("/indexes/docs/docs/index");
    const body = parseBody(init) as { value: Array<Record<string, unknown>> };
    expect(body.value).toHaveLength(2);
    expect(body.value[0]).toMatchObject({
      "@search.action": "delete",
      id: "a",
      tenant_id: "tenant-a",
    });
    expect(body.value[1]).toMatchObject({
      "@search.action": "delete",
      id: "b",
      tenant_id: "tenant-a",
    });

    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_delete_ok",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        doc_count: 2,
      }),
    );
  });

  test("failure returns { deleted: 0 } and emits rag.vector_delete_failed", async () => {
    mockFetchOnce(errResponse(500));
    const store = createAzureAiSearchStore(CFG);

    const result = await store.delete(["a"], "t");
    expect(result).toEqual({ deleted: 0 });
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_delete_failed",
      "system",
      "system",
      expect.objectContaining({ provider: "azure_ai_search" }),
    );
  });
});

/* ─────────────────────── health ─────────────────────── */

describe("createAzureAiSearchStore.health", () => {
  test("ok: GETs the index root and emits rag.vector_health_ok", async () => {
    const spy = mockFetchOnce(okJson({ name: "docs" }));
    const store = createAzureAiSearchStore(CFG);

    const res = await store.health();

    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe("number");

    const { url, init } = lastFetchCall(spy);
    expect(init.method).toBe("GET");
    expect(url).toBe(
      "https://example.search.windows.net/indexes/docs?api-version=2024-07-01",
    );
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_health_ok",
      "system",
      "system",
      expect.objectContaining({ provider: "azure_ai_search" }),
    );
  });

  test("404: returns { ok: false, detail } and emits rag.vector_health_failed", async () => {
    mockFetchOnce(errResponse(404, "not found"));
    const store = createAzureAiSearchStore(CFG);

    const res = await store.health();
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/404/);
    expect(mockEmit).toHaveBeenCalledWith(
      "rag.vector_health_failed",
      "system",
      "system",
      expect.objectContaining({
        provider: "azure_ai_search",
        error: expect.stringMatching(/404/),
      }),
    );
  });
});

export {};
