/**
 * @jest-environment jsdom
 *
 * brain-embeddings — lazy MiniLM loader contract tests.
 *
 * We never actually pull @xenova/transformers here (that's a ~25MB
 * weight fetch). Every test injects a fake `pipelineFactory` through
 * the public `EmbeddingsOptions` seam. `__resetForTests` is called
 * between tests so the module-level singleton + failure latch don't
 * leak across cases.
 */

import "fake-indexeddb/auto";
import {
  embedQuery,
  getEmbeddingPipeline,
  preloadModel,
  __resetForTests,
} from "@/lib/brain-embeddings";

type AnalyticsEvent = [string, Record<string, string | number | boolean>];

function makePipeOutput(vec: number[]): {
  data: Float32Array;
  dims: number[];
} {
  return { data: Float32Array.from(vec), dims: [1, vec.length] };
}

beforeEach(() => {
  __resetForTests();
  window.localStorage.clear();
});

afterEach(() => {
  __resetForTests();
  jest.restoreAllMocks();
});

describe("embedQuery — happy path", () => {
  it("lazy-loads the pipeline on first call and reuses it on second", async () => {
    const events: AnalyticsEvent[] = [];
    const factory = jest
      .fn()
      .mockResolvedValue(
        jest.fn(async (_input: string) =>
          makePipeOutput([0.1, 0.2, 0.3]),
        ),
      );

    const v1 = await embedQuery("hello world", {
      pipelineFactory: factory,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    const v2 = await embedQuery("second call", {
      pipelineFactory: factory,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(v1).toEqual([0.1, 0.2, 0.3].map((n) => expect.closeTo(n, 6)));
    expect(v2).toEqual([0.1, 0.2, 0.3].map((n) => expect.closeTo(n, 6)));
    expect(factory).toHaveBeenCalledTimes(1);

    expect(events.some(([e]) => e === "brain.embedding_model_loaded")).toBe(
      true,
    );
    expect(
      events.filter(([e]) => e === "brain.query_embedded").length,
    ).toBe(2);
    expect(
      events.some(([e]) => e === "brain.embedding_model_load_failed"),
    ).toBe(false);
  });

  it("preloadModel returns true when pipeline is ready", async () => {
    const factory = jest
      .fn()
      .mockResolvedValue(
        jest.fn(async () => makePipeOutput([0, 1, 0])),
      );
    const ok = await preloadModel({ pipelineFactory: factory });
    expect(ok).toBe(true);
  });
});

describe("embedQuery — timeout", () => {
  it("returns null and emits load_failed when the factory hangs past timeout", async () => {
    const events: AnalyticsEvent[] = [];
    const factory: jest.Mock = jest.fn(
      () => new Promise(() => {}) /* never resolves */,
    );

    const vec = await embedQuery("anything", {
      pipelineFactory: factory,
      loadTimeoutMs: 5,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(vec).toBeNull();
    expect(
      events.some(([e]) => e === "brain.embedding_model_load_failed"),
    ).toBe(true);
  });
});

describe("embedQuery — load failure", () => {
  it("returns null and latches the failure (next call short-circuits)", async () => {
    const events: AnalyticsEvent[] = [];
    const factory = jest.fn().mockRejectedValue(new Error("boom"));

    const v1 = await embedQuery("q1", {
      pipelineFactory: factory,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    const v2 = await embedQuery("q2", {
      pipelineFactory: factory,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(v1).toBeNull();
    expect(v2).toBeNull();
    // Latched — factory NOT retried.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(
      events.some(([e]) => e === "brain.embedding_model_load_failed"),
    ).toBe(true);
  });

  it("returns null when the factory resolves to a non-function", async () => {
    const factory = jest.fn().mockResolvedValue({ not: "a pipeline" });
    const vec = await embedQuery("q", { pipelineFactory: factory });
    expect(vec).toBeNull();
  });

  it("returns null on empty / whitespace input", async () => {
    const factory = jest
      .fn()
      .mockResolvedValue(jest.fn(async () => makePipeOutput([1])));
    expect(await embedQuery("", { pipelineFactory: factory })).toBeNull();
    expect(await embedQuery("   ", { pipelineFactory: factory })).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns null when the pipeline throws during encode", async () => {
    const pipe = jest.fn(async () => {
      throw new Error("encode-boom");
    });
    const factory = jest.fn().mockResolvedValue(pipe);
    const vec = await embedQuery("q", { pipelineFactory: factory });
    expect(vec).toBeNull();
  });

  it("returns null when the pipeline returns empty data", async () => {
    const pipe = jest.fn(async () => ({ data: new Float32Array(0) }));
    const factory = jest.fn().mockResolvedValue(pipe);
    const vec = await embedQuery("q", { pipelineFactory: factory });
    expect(vec).toBeNull();
  });
});

describe("getEmbeddingPipeline — singleton reuse", () => {
  it("returns the same pipeline across concurrent callers", async () => {
    let resolveFactory: (pipe: unknown) => void = () => {};
    const factoryPromise = new Promise((res) => {
      resolveFactory = res;
    });
    const factory = jest.fn().mockReturnValue(factoryPromise);

    const pA = getEmbeddingPipeline({ pipelineFactory: factory });
    const pB = getEmbeddingPipeline({ pipelineFactory: factory });
    resolveFactory(jest.fn(async () => makePipeOutput([1, 2, 3])));

    const [a, b] = await Promise.all([pA, pB]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
