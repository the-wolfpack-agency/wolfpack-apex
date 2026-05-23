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
export type SearchType =
  | "chat"
  | "channel"
  | "email"
  | "calendar"
  | "knowledge"
  | "crm"
  | "dms"
  | "vercel";

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

export const ALL_SEARCH_TYPES: ReadonlyArray<SearchType> = [
  "chat",
  "channel",
  "email",
  "calendar",
  "knowledge",
  "crm",
  "dms",
  "vercel",
];
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
        const results = await provider.search(q, perType, ctx);
        const tookMs = Date.now() - start;
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
