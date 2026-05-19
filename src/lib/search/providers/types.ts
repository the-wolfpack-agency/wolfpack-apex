/**
 * Universal Search — provider contract.
 *
 * Every retriever Universal Search fans out to is a `SearchProvider`.
 * Providers live in this directory and register themselves in
 * `./index.ts`. The runSearch engine iterates that registry, runs each
 * enabled provider in parallel, and interleaves results.
 *
 * Adding a new tool that exposes searchable data? Export a
 * `searchProvider` from the tool module AND add it to the registry.
 * The `provider-coverage` guardrail test enforces this — every tool
 * either has a provider or is explicitly exempt with a reason.
 *
 * Contract rules:
 *   - `type` is the value that appears on `SearchResult.type`. New
 *     providers MUST add their `type` to the `SearchType` union in
 *     `../runSearch.ts` (the same guardrail covers that).
 *   - `countKey` is the bucket the provider populates inside
 *     `SearchResponse.counts`. New keys land in `SearchResponse.counts`
 *     additively — existing keys preserved.
 *   - `isEnabled` is consulted PER REQUEST (not at registration time)
 *     so per-tenant config like "this workspace has no CRM connector"
 *     skips the provider cleanly.
 *   - `search` is best-effort. The engine wraps it in
 *     `Promise.allSettled` so a thrown/rejected provider degrades to
 *     zero results without blocking the rest of the fan-out.
 */

import type { SearchResult } from "../runSearch";

export interface RunSearchContext {
  /** Scopes Graph (delegated token) and knowledge queries. */
  userId: string;
  /**
   * Workspace whose per-tenant config (CRM connectors, custom data
   * sources) the provider should consult. Defaults to "default" when
   * the caller didn't surface a workspace.
   */
  workspaceId?: string;
  /** Optional — analytics correlation when invoked from the assistant. */
  workflowId?: string;
}

export interface SearchProvider {
  /** Identifier that appears on `SearchResult.type` for every hit this
   *  provider returns. Must be a value in the `SearchType` union. */
  type: string;
  /** Human-readable label used in failure analytics ("Salesforce CRM",
   *  "Microsoft Teams chats"). No PII. */
  name: string;
  /** Bucket on `SearchResponse.counts` this provider populates. */
  countKey: string;
  /** Per-request gate. Returning false skips this provider entirely
   *  for the current request. Used by CRM to opt out when the
   *  workspace has no active connector. */
  isEnabled(ctx: RunSearchContext): Promise<boolean> | boolean;
  /** Best-effort retrieval. May throw — the engine catches and logs. */
  search(
    query: string,
    limit: number,
    ctx: RunSearchContext,
  ): Promise<SearchResult[]>;
}
