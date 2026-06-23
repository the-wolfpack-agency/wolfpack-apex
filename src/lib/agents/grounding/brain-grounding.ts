/**
 * Brain grounding for governed agent execution.
 *
 * Before an agent spends AI tokens exploring a goal, it consults the org Brain
 * (team knowledge) so the work is informed by what the organization already
 * knows. This is the "deploy into a new system, get cheaper over time" lever on
 * the AI side: relevant prior knowledge reduces how much the agent has to
 * rediscover (and pay for) from scratch.
 *
 * Hard constraints baked in here:
 *   - DETERMINISTIC-FIRST. This is only ever called on an EXPLORING run. A run
 *     that reused a promoted (deterministic) procedure must not reach this code
 *     at all, so reuse stays genuinely free of token consideration. The executor
 *     enforces that; this module stays pure-ish and side-effect-light so it is
 *     safe to call only when exploring.
 *   - GRACEFUL DEGRADATION. If embeddings are not configured we skip the Brain
 *     entirely and return an empty grounding at ZERO cost (no network, no DB).
 *     If a Brain query throws for any reason we swallow it and return the empty
 *     grounding. Grounding is a best-effort speedup, never a dependency; the
 *     agent always runs.
 *   - WORKSPACE-SCOPED. Every query carries the agent's workspaceId so an agent
 *     can only ground against its own tenant's knowledge.
 *
 * The Brain query + embedding gate are injected via `deps` so this is fully
 * unit-testable without a live Brain, embedder, or database.
 */

import { isEmbeddingConfigured as defaultIsEmbeddingConfigured } from "@/lib/brain/embedder";
import { queryBrain as defaultQueryBrain } from "@/lib/brain/query";
import type { QueryExecution } from "@/lib/brain/query";

/** How many Brain hits to fold into a grounding context. Small by design: a few
 *  high-signal snippets reduce tokens; a flood of them would add tokens. */
const DEFAULT_LIMIT = 3;
/** Max characters per snippet. Truncated so grounding stays cheap. */
const SNIPPET_MAX = 280;

/**
 * The result of grounding an exploring run against the Brain. `used` is true
 * only when embeddings were configured AND a query actually ran (it may still
 * have returned zero hits). `snippets` are short, truncated knowledge excerpts a
 * downstream AI-backed tool MAY fold into its prompt to spend fewer tokens.
 */
export interface Grounding {
  used: boolean;
  hits: number;
  snippets: string[];
}

/** The empty, zero-cost grounding. Returned whenever the Brain is skipped or
 *  fails, so callers always get a well-formed value and never a throw. */
const EMPTY: Grounding = { used: false, hits: 0, snippets: [] };

/**
 * Minimal query shape grounding depends on. Intentionally looser than the
 * Brain's full QueryOpts (which is a human-turn shape) so we can pass a
 * workspace scope + agent actor without coupling to fields we don't use. The
 * real queryBrain satisfies this structurally.
 */
export type GroundingQueryFn = (opts: {
  query: string;
  limit?: number;
  workspaceId?: string;
  userId: string;
  userRole: string;
}) => Promise<Pick<QueryExecution, "hits">>;

/** Injectable seams so tests can run without a live Brain/embedder. */
export interface GroundingDeps {
  isEmbeddingConfigured?: () => boolean;
  queryBrain?: GroundingQueryFn;
  /** Workspace actor identity for the (workspace-scoped) Brain query log. The
   *  Brain query layer requires a userId/userRole for its audit row; an agent
   *  grounding on behalf of its workspace passes its own agent id + role. */
  userId?: string;
  userRole?: string;
}

function truncate(s: string, n = SNIPPET_MAX): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Ground an exploring run against the workspace's Brain. Never throws; returns
 * an empty grounding on skip or failure.
 *
 * @param goal        the task goal to retrieve knowledge for.
 * @param workspaceId tenant scope; the query is restricted to this workspace.
 * @param deps        injectable embedder gate + Brain query (+ actor identity).
 */
export async function groundFromBrain(
  goal: string,
  workspaceId: string,
  deps: GroundingDeps = {},
): Promise<Grounding> {
  const isConfigured = deps.isEmbeddingConfigured ?? defaultIsEmbeddingConfigured;
  const runQuery: GroundingQueryFn =
    deps.queryBrain ?? (defaultQueryBrain as unknown as GroundingQueryFn);

  // No goal -> nothing to ground. Zero cost.
  const q = (goal ?? "").trim();
  if (!q) return EMPTY;

  // Embeddings unconfigured: the Brain cannot do semantic retrieval, so skip it
  // entirely. Zero cost, no query, deterministic-first stays intact.
  if (!isConfigured()) return EMPTY;

  try {
    const result = await runQuery({
      query: q,
      limit: DEFAULT_LIMIT,
      workspaceId,
      // Workspace-scoped actor for the Brain query-log audit row. The agent
      // grounds on behalf of its workspace under its own identity.
      userId: deps.userId ?? `agent:${workspaceId}`,
      userRole: deps.userRole ?? "agent",
    });

    const hits = Array.isArray(result?.hits) ? result.hits : [];
    const snippets = hits
      .slice(0, DEFAULT_LIMIT)
      .map((h) => truncate(h?.snippet || h?.content || ""))
      .filter((s) => s.length > 0);

    return { used: true, hits: hits.length, snippets };
  } catch {
    // Any Brain/embedder/DB hiccup degrades to the empty grounding. The agent
    // still runs; grounding is a best-effort speedup, never a hard dependency.
    return EMPTY;
  }
}
