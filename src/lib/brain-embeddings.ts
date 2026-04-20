"use client";

/**
 * brain-embeddings — Client-side MiniLM loader for Brain Pack Level-2.
 *
 * Lazy-loads the `@xenova/transformers` feature-extraction pipeline for
 * `Xenova/all-MiniLM-L6-v2` (384-dim, ~25MB compressed) the first time
 * a caller asks to embed a query. The pipeline is cached as a
 * module-level singleton — subsequent calls reuse the same instance
 * without re-fetching weights.
 *
 * Contract with the rest of the Level-2 stack:
 *
 *   - `embedQuery(text)` → `Promise<number[] | null>`. Resolves with a
 *     384-dim Float array on success, or `null` when the loader timed
 *     out / failed (so the caller can fall back to keyword-only or the
 *     Level-1 fingerprint path). It NEVER throws.
 *
 *   - `preloadModel()` → `Promise<boolean>`. Optional eager warmup the
 *     caller can trigger when it knows the user is about to go offline
 *     (e.g. right after a pack download completes). Same non-throwing
 *     contract as `embedQuery`.
 *
 *   - `__resetForTests()` — clears the singleton + cached failure state
 *     so Jest tests can exercise first-load / timeout / failure
 *     branches deterministically.
 *
 * Why no dynamic service-worker install step here? The existing
 * `public/sw.js` already serves same-origin static assets with
 * `stale-while-revalidate`. `@xenova/transformers` fetches its weight
 * files from the `Xenova/…` HuggingFace CDN by default; when Vercel is
 * configured to proxy those through a same-origin `/models/` mount the
 * SW will pick them up automatically. On first load the weights pay
 * full network cost; on subsequent loads the SW serves them from cache.
 * No custom SW wiring needed — we just emit analytics so the learning
 * loop can see the cold-start cost per device.
 *
 * Analytics:
 *   - `brain.embedding_model_loaded         { duration_ms, size_bytes }`
 *     on first successful pipeline creation.
 *   - `brain.embedding_model_load_failed    { error }` on timeout /
 *     throw / unexpected pipeline shape.
 *   - `brain.query_embedded                 { duration_ms }` on every
 *     successful encode (NOT on the cold-start call — the load event
 *     already captures that latency).
 */

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeatureExtractionPipeline = (
  input: string | string[],
  options?: { pooling?: "mean" | "none" | "cls"; normalize?: boolean },
) => Promise<{
  data: Float32Array | number[];
  dims?: number[];
}>;

type PipelineFactory = (
  task: "feature-extraction",
  model: string,
) => Promise<FeatureExtractionPipeline>;

export interface EmbeddingsOptions {
  /** Test seam — inject a pipeline() factory instead of dynamic import. */
  pipelineFactory?: PipelineFactory;
  /** Override the 30s first-load timeout. */
  loadTimeoutMs?: number;
  /**
   * Analytics override for tests. Replaces trackEvent() — same signature
   * as the analytics primitive (event name + metadata dict).
   */
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;

let pipelinePromise: Promise<FeatureExtractionPipeline | null> | null = null;
let loadFailed = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (typeof window === "undefined") return;
  const token = getInstinctToken();
  if (!token) return;
  try {
    await fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, metadata }),
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}

function emit(
  event:
    | "brain.embedding_model_loaded"
    | "brain.embedding_model_load_failed"
    | "brain.query_embedded",
  metadata: Record<string, string | number | boolean>,
  override?: EmbeddingsOptions["onAnalytics"],
): void {
  if (override) {
    try {
      override(event, metadata);
    } catch {
      /* analytics override must never throw */
    }
    return;
  }
  // Fire-and-forget through the canonical client-side analytics route.
  void postAnalytics(event, metadata);
}

async function loadPipelineWithTimeout(
  factory: PipelineFactory,
  timeoutMs: number,
): Promise<FeatureExtractionPipeline> {
  return new Promise<FeatureExtractionPipeline>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`embedding_model_load_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    factory("feature-extraction", MODEL_ID)
      .then((pipe) => {
        clearTimeout(timer);
        if (typeof pipe !== "function") {
          reject(new Error("pipeline_factory_returned_non_function"));
          return;
        }
        resolve(pipe);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

async function defaultPipelineFactory(
  task: "feature-extraction",
  model: string,
): Promise<FeatureExtractionPipeline> {
  // Dynamic import so the transformers bundle NEVER lands in the main
  // JS graph. SSR / node-side callers that accidentally reach this path
  // will get an unresolved dynamic import instead of a hard build error.
  const mod = (await import(
    /* webpackChunkName: "xenova-transformers" */
    "@xenova/transformers"
  )) as { pipeline: PipelineFactory };
  return mod.pipeline(task, model);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the singleton pipeline, loading it on first call. Returns
 * `null` when load has failed (permanently until reset) so callers
 * can short-circuit without branching on try/catch.
 */
export async function getEmbeddingPipeline(
  opts?: EmbeddingsOptions,
): Promise<FeatureExtractionPipeline | null> {
  if (loadFailed) return null;
  if (pipelinePromise) return pipelinePromise;

  const factory = opts?.pipelineFactory ?? defaultPipelineFactory;
  const timeoutMs = opts?.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const t0 = Date.now();

  pipelinePromise = loadPipelineWithTimeout(factory, timeoutMs)
    .then((pipe) => {
      const duration_ms = Date.now() - t0;
      emit(
        "brain.embedding_model_loaded",
        { duration_ms, size_bytes: 0 },
        opts?.onAnalytics,
      );
      return pipe;
    })
    .catch((err: Error) => {
      loadFailed = true;
      pipelinePromise = null;
      emit(
        "brain.embedding_model_load_failed",
        { error: (err.message || "unknown").slice(0, 160) },
        opts?.onAnalytics,
      );
      return null;
    });

  return pipelinePromise;
}

/**
 * Embed a single query string. Returns `null` when the model failed to
 * load or the encoding itself threw; callers should treat `null` as
 * "skip semantic branch, use keyword fallback only".
 */
export async function embedQuery(
  query: string,
  opts?: EmbeddingsOptions,
): Promise<number[] | null> {
  if (typeof query !== "string" || query.trim().length === 0) return null;

  const pipe = await getEmbeddingPipeline(opts);
  if (!pipe) return null;

  const t0 = Date.now();
  try {
    const output = await pipe(query, { pooling: "mean", normalize: true });
    const raw = output?.data;
    if (!raw) return null;
    const vec = raw instanceof Float32Array ? Array.from(raw) : [...raw];
    if (vec.length === 0) return null;
    emit(
      "brain.query_embedded",
      { duration_ms: Date.now() - t0 },
      opts?.onAnalytics,
    );
    return vec;
  } catch {
    return null;
  }
}

/**
 * Explicit warm-up. Returns true when the pipeline is ready, false on
 * failure. Non-throwing.
 */
export async function preloadModel(
  opts?: EmbeddingsOptions,
): Promise<boolean> {
  const pipe = await getEmbeddingPipeline(opts);
  return pipe !== null;
}

/**
 * Test helper — wipe the singleton + failure latch. Only invoked from
 * `__tests__/brain-embeddings.test.ts`.
 */
export function __resetForTests(): void {
  pipelinePromise = null;
  loadFailed = false;
}
