/**
 * Universal Search — runSearch
 *
 * Single retrieval engine shared by:
 *   1. /api/search        — the deployed search page route handler.
 *   2. The assistant `search` tool — so the chat surface returns
 *      IDENTICAL results to the page.
 *
 * Identical-results invariant: anything that branches behavior between
 * the two callers belongs in the caller, not here. Add knobs to
 * RunSearchParams / RunSearchContext rather than reading globals or
 * branching on caller-shape.
 *
 * Provider registry: every retriever lives in `./providers/` and self-
 * registers in `./providers/index.ts`. The engine iterates the registry
 * — `SEARCH_PROVIDERS` — and runs each enabled provider in parallel
 * via Promise.allSettled. A thrown/rejected provider degrades to zero
 * results without blocking the rest of the fan-out. New surfaces
 * (CRM, future tools) land as one new provider file + one line in the
 * registry; no engine changes.
 *
 * v1 strategy: server-side substring/keyword filtering over the user's
 * RECENTLY-FETCHED items. This is intentionally NOT semantic search —
 * that's the Azure AI Search swap target. When we cut over, this
 * module's response shape stays identical; only the providers' inner
 * helpers get replaced with index lookups.
 */

import { trackEvent } from "@/lib/analytics";
import { SEARCH_PROVIDERS } from "./providers";
import type { RunSearchContext, SearchProvider } from "./providers/types";

/**
 * Stable literal union of every provider type. Compile-time safe; the
 * `searchTypesAreCovered` test asserts every registered provider's
 * `type` is a value of this union, so a new provider that forgets to
 * extend the union fails at PR time, not at runtime.
 */
import { SEARCH_TYPE_VALUES } from "./search-types";
import type { SearchType } from "./search-types";
export type { SearchType };

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  snippet: string;
  /** ISO timestamp; may be empty when the source has no timestamp
   *  (e.g. channel-name match — channel itself has no createdDateTime,
   *  or a CRM record without a modstamp). */
  timestamp: string;
  url?: string;
}

/**
 * Per-bucket counts. The known keys (chats / channels / emails /
 * calendar / knowledge / crm) are guaranteed to be present on every
 * response so existing callers don't break. Additional keys may
 * appear as new providers register — additive only.
 */
export interface SearchResponseCounts {
  chats: number;
  channels: number;
  emails: number;
  calendar: number;
  knowledge: number;
  crm: number;
  dms: number;
  [key: string]: number;
}

export interface SearchResponse {
  results: SearchResult[];
  took_ms: number;
  counts: SearchResponseCounts;
}

export interface RunSearchParams {
  query: string;
  /** Default = all providers. */
  types?: SearchType[];
  /** Default 20, clamped to [1, 50]. */
  limit?: number;
}

export type { RunSearchContext };

/**
 * DERIVED, NOT RESTATED. This array decides which providers actually run, and
 * it was a separate hand-maintained copy of the type list. The Brain provider
 * was registered, exported, unit tested and green, and never executed once,
 * because its type was missing from here: normalizeTypes intersects the
 * request against this array, brain fell out, and search returned "No results
 * found" for questions the corpus could answer.
 *
 * Nothing failed. The provider tests passed against the provider directly, and
 * only running the real pipeline showed the feature was dead.
 */
export const ALL_SEARCH_TYPES: ReadonlyArray<SearchType> = SEARCH_TYPE_VALUES;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Server-side cap on accepted query length. Mirrors the zod schema
 *  shape callers should declare; runSearch enforces defensively so
 *  any direct call also clamps. */
export const MAX_QUERY_LENGTH = 200;

/** Sentinel that survives `Promise.allSettled` and tells the merge
 *  pass which provider rejected. The engine emits a
 *  `system.search_provider_failed` event and treats the bucket as
 *  empty so other providers' results still flow through. */
interface ProviderRun {
  provider: SearchProvider;
  results: SearchResult[];
  ok: boolean;
  tookMs: number;
  /** True when this provider was still running when the budget expired. */
  timedOut?: boolean;
}

/**
 * How long any single provider may hold up the whole search.
 *
 * MEASURED, NOT GUESSED. Per-provider latency over seven days of production
 * traffic, in milliseconds:
 *
 *   Microsoft Teams channels   avg 5515   p95 22454   max 129458
 *   Microsoft Teams chats      avg  594   p95  2681   max   5024
 *   CRM                        avg 1168   p95  1805   max   3116
 *   Documents                  avg  705   p95  1187   max   3321
 *   SharePoint                 avg  403   p95  1615   max   2181
 *   Outlook calendar           avg  250   p95  1230   max   2955
 *   Outlook emails             avg  103   p95   527   max   2475
 *   Instinct knowledge         avg   38   p95   102   max    219
 *
 * One provider is the entire problem. Channel search took over two minutes at
 * its worst and 22 seconds at p95, while every other provider finished inside
 * 3.4 seconds even in its worst observed case. The fan-out is parallel, so the
 * slowest provider IS the search: a reader typing a question waited on Teams
 * channels and nothing else.
 *
 * 6000ms sits above the worst observed case of every other provider and well
 * below Teams channels' p95, so this bounds the outlier and changes nothing
 * about the rest. It is deliberately not tuned to the average: a budget that
 * cuts off a provider having a slightly slow day would trade a real result for
 * a small time saving.
 */
export const PROVIDER_BUDGET_MS = 6_000;

/**
 * Resolve to a sentinel rather than reject, so a slow provider is recorded as
 * SLOW rather than as failed, and never as empty.
 *
 * The distinction matters for the same reason it has mattered everywhere else
 * in this codebase: "found nothing" and "did not finish" lead to different
 * actions, and a reader cannot tell them apart from an empty list.
 */
const TIMED_OUT = Symbol("provider-timed-out");

function withBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        /* RE-THROWN, NOT SWALLOWED. Written first as resolve(TIMED_OUT), which
           relabelled every genuine provider failure as a timeout and would
           have hidden a broken connector behind a latency story. The test for
           a rejecting provider caught it. A rejection belongs to the caller's
           catch, which records it as failed. */
        reject(err);
      },
    );
  });
}

function normalizeTypes(types: SearchType[] | undefined): Set<SearchType> {
  if (!types || types.length === 0) return new Set<SearchType>(ALL_SEARCH_TYPES);
  const allowed = new Set<SearchType>(ALL_SEARCH_TYPES);
  const out = new Set<SearchType>();
  for (const t of types) {
    if (allowed.has(t)) out.add(t);
  }
  return out.size === 0 ? new Set<SearchType>(ALL_SEARCH_TYPES) : out;
}

/** Even-share allocation across enabled providers. With N providers and
 *  `limit` total slots, each provider gets ceil(limit/N) — small enough
 *  that no one provider starves another. The aggregator caps the final
 *  concatenated list at `limit` after merging. */
function perTypeLimitFor(enabledCount: number, limit: number): number {
  return Math.max(2, Math.ceil(limit / Math.max(1, enabledCount)));
}

/**
 * Run a Universal Search. Returns the merged, capped result list plus
 * per-provider counts and wall-clock latency.
 *
 * Never throws — every provider is independently catch-and-empty so
 * partial degradation surfaces as fewer results, not a 500.
 */
export async function runSearch(
  params: RunSearchParams,
  ctx: RunSearchContext,
): Promise<SearchResponse> {
  const t0 = Date.now();
  const q = (params.query || "").trim().slice(0, MAX_QUERY_LENGTH);
  const requestedTypes = normalizeTypes(params.types);
  const limitRaw =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? params.limit
      : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)));

  /* Resolve which providers will actually run: in the requested types
   *  set AND enabled for this request (per-tenant gating). */
  const candidate = SEARCH_PROVIDERS.filter((p) =>
    requestedTypes.has(p.type as SearchType),
  );
  const enabledChecks = await Promise.all(
    candidate.map(async (p) => {
      try {
        return (await p.isEnabled(ctx)) ? p : null;
      } catch {
        return null;
      }
    }),
  );
  const enabled = enabledChecks.filter((p): p is SearchProvider => p !== null);

  /* Build the zero-results scaffold so callers always see every known
   *  countKey even when the provider was skipped. */
  const counts: SearchResponseCounts = {
    chats: 0,
    channels: 0,
    emails: 0,
    calendar: 0,
    knowledge: 0,
    crm: 0,
    dms: 0,
  };

  if (enabled.length === 0) {
    return { results: [], took_ms: Date.now() - t0, counts };
  }

  const perType = perTypeLimitFor(enabled.length, limit);

  /* Run all enabled providers in parallel; allSettled so one rejection
   *  doesn't block the rest. Each provider's wall-clock latency is
   *  measured separately for the per-provider analytics event. */
  const runs: ProviderRun[] = await Promise.all(
    enabled.map(async (provider): Promise<ProviderRun> => {
      const start = Date.now();
      try {
        const outcome = await withBudget(provider.search(q, perType, ctx), PROVIDER_BUDGET_MS);
        const tookMs = Date.now() - start;
        if (outcome === TIMED_OUT) {
          /* Recorded as its own event so a provider that starts timing out is
             visible as a trend rather than as a gradual slowdown nobody
             attributes to anything. */
          trackEvent("system.search_provider_timed_out", ctx.userId, "system", {
            provider: provider.name,
            budget_ms: PROVIDER_BUDGET_MS,
            query_length: q.length,
            ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
          });
          return { provider, results: [], ok: false, tookMs, timedOut: true };
        }
        const results = outcome;
        trackEvent(
          "assistant.search_provider_executed",
          ctx.userId,
          "system",
          {
            provider: provider.name,
            query_length: q.length,
            match_count: results.length,
            took_ms: tookMs,
            ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
          },
        );
        return { provider, results, ok: true, tookMs };
      } catch (err) {
        const tookMs = Date.now() - start;
        trackEvent(
          "system.search_provider_failed",
          ctx.userId,
          "system",
          {
            provider: provider.name,
            message: (err as Error)?.message ?? "unknown",
            ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
          },
        );
        return { provider, results: [], ok: false, tookMs };
      }
    }),
  );

  /* Populate counts per provider's countKey. */
  for (const run of runs) {
    counts[run.provider.countKey] = run.results.length;
  }

  /* Interleave merge — round-robin across providers preserves the
   *  fairness behavior of the pre-registry engine: no single provider
   *  dominates the first page even when it returned many matches. */
  const merged: SearchResult[] = [];
  let added = true;
  let idx = 0;
  while (added && merged.length < limit) {
    added = false;
    for (const run of runs) {
      if (idx < run.results.length && merged.length < limit) {
        merged.push(run.results[idx]);
        added = true;
      }
    }
    idx += 1;
  }

  return {
    results: merged,
    took_ms: Date.now() - t0,
    counts,
  };
}
