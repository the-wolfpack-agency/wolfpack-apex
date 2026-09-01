/**
 * A throttled embedder must not silently halve the search.
 *
 * WHAT THIS FIXES, measured over 90 days of production:
 *
 *     rag.embedding_failed   n=178   HTTP 429 RateLimitReached
 *     rag.embedding_failed   n= 63   HTTP 404 DeploymentNotFound (since fixed)
 *     rag.embedding_failed   n= 13   fetch failed (most recent, 2026-08-30)
 *
 * On any of those the adapter returned [], the caller reported "embedder
 * returned no vector", the Brain fell back to keyword-only, and nobody was
 * told. 73 semantic-degraded events since the deployment was configured.
 *
 * THAT IS THE VOCABULARY-MISMATCH BUG. Keyword search cannot bridge "how much
 * do we owe upfront" to "50% is due within 30 days". Semantic can, and
 * semantic was not running. Four questions in the retrieval eval have never
 * found their document, and two of them are that exact pair.
 *
 * A 429 is the most retryable error there is: the request was fine and the
 * service was busy. This is the same defect the model router had this morning,
 * one layer down, which is why the classification is IMPORTED from the router
 * rather than restated here.
 */

const mockEmit = jest.fn();
jest.mock("@/lib/rag-providers/analytics-shim", () => ({
  emitRagEvent: (...a: unknown[]) => mockEmit(...a),
}));

import { createAzureOpenAIEmbedder } from "@/lib/rag-providers/azure-openai";

const fetchMock = jest.fn();
const CFG = {
  endpoint: "https://test-resource.openai.azure.com",
  apiKey: "k",
  deployment: "text-embedding-3-small",
};

function ok(vectors: number[][]) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ data: vectors.map((embedding, index) => ({ embedding, index })) }),
  };
}
function throttled(retryAfter?: string) {
  return {
    ok: false,
    status: 429,
    headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
    text: async () => '{"error":{"code":"RateLimitReached"}}',
  };
}

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  jest.clearAllMocks();
});

describe("a throttled embedding call", () => {
  it("retries and returns the vectors, so the search stays whole", async () => {
    fetchMock.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(ok([[0.1, 0.2]]));
    const out = await createAzureOpenAIEmbedder(CFG).embed(["what are the payment terms"]);
    expect(out).toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    /* Recovered, so nothing is reported as failed. */
    expect(mockEmit).not.toHaveBeenCalledWith(
      "rag.embedding_failed",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("honours Retry-After when the service sends one", async () => {
    fetchMock.mockResolvedValueOnce(throttled("1")).mockResolvedValueOnce(ok([[0.3]]));
    const started = Date.now();
    await createAzureOpenAIEmbedder(CFG).embed(["x"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  /* ONE retry, not a loop. A deployment that is throttled twice running is
     over capacity, and hammering it makes that worse. */
  it("gives up after one retry and says so", async () => {
    fetchMock.mockResolvedValue(throttled());
    const out = await createAzureOpenAIEmbedder(CFG).embed(["x"]);
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const failure = mockEmit.mock.calls.find((c) => c[0] === "rag.embedding_failed")!;
    expect(failure[3]).toMatchObject({ retried: true });
  });

  /* The most recent failures are thrown, not returned. */
  it("retries a thrown network error", async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(ok([[0.9]]));
    expect(await createAzureOpenAIEmbedder(CFG).embed(["x"])).toEqual([[0.9]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("what must NOT be retried", () => {
  /* A missing deployment fails identically the second time. Retrying it would
     double every call during a misconfiguration, which is when the service is
     least able to take it. */
  it("does not retry a missing deployment", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => '{"error":{"code":"DeploymentNotFound"}}',
    });
    const out = await createAzureOpenAIEmbedder(CFG).embed(["x"]);
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls.find((c) => c[0] === "rag.embedding_failed")![3]).toMatchObject({
      retried: false,
    });
  });

  it("does not retry a bad request", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => "bad input",
    });
    await createAzureOpenAIEmbedder(CFG).embed(["x"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call out at all for an empty batch", async () => {
    expect(await createAzureOpenAIEmbedder(CFG).embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
