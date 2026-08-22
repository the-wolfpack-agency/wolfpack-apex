/**
 * src/lib/ai/workspace-policy, per-workspace AI routing policy.
 *
 * Lets an admin pin a model tier and/or provider per workspace so finance
 * teams get premium models while support teams stay on cheap, a CFO-visible
 * cost lever.
 *
 * Design constraints:
 *   - Pure resolver: clamp requestedTier DOWN to policy.max_tier (never UP).
 *     A policy can only restrict, never escalate, for cost safety.
 *   - loadWorkspacePolicy NEVER throws, a missing/broken policy row must not
 *     break the gateway. Degrade to the request's own tier instead.
 *   - No Date.now / Math.random / new dependencies.
 *
 * Analytics hook: the gateway calls buildPolicyEventMetadata() and emits an
 * `ai.policy_applied` event. This file only shapes the metadata; it does not
 * call trackEvent() so the module stays pure and testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTier = "cheap" | "standard" | "premium";

export type ProviderOverride = "anthropic" | "azure-openai" | undefined;

export interface WorkspaceAIPolicy {
  workspace_id: string;
  /** null means no cap, any tier is allowed */
  max_tier: ModelTier | null;
  provider_override: ProviderOverride;
  /** null means no budget limit */
  monthly_budget_usd: number | null;
  /**
   * Which CONTENT policy this workspace's answers are held to, distinct from
   * the routing policy above: that one decides which model answers and what it
   * may cost, this one decides what the answer is allowed to say.
   *
   * null means the deployment default (the baseline set). A workspace never
   * has "no policy" -- see src/lib/ai/policy.ts.
   */
  content_policy_profile?: string | null;
}

export interface ResolvedPolicy {
  tier: ModelTier;
  provider_override: ProviderOverride;
  /** true when requestedTier was clamped down to policy.max_tier */
  capped: boolean;
}

// ---------------------------------------------------------------------------
// Tier ordering
// ---------------------------------------------------------------------------

const TIER_RANK: Record<ModelTier, number> = {
  cheap: 0,
  standard: 1,
  premium: 2,
};

// ---------------------------------------------------------------------------
// resolvePolicy
// ---------------------------------------------------------------------------

/**
 * Clamp requestedTier down to policy.max_tier.
 * - Never escalates (cheap request + premium cap stays cheap).
 * - capped=true only when an actual clamp happened.
 * - null policy or null max_tier: passthrough.
 */
export function resolvePolicy(
  requestedTier: ModelTier,
  policy: WorkspaceAIPolicy | null,
): ResolvedPolicy {
  const override = policy?.provider_override;

  if (!policy || policy.max_tier === null) {
    return { tier: requestedTier, provider_override: override, capped: false };
  }

  const maxRank = TIER_RANK[policy.max_tier];
  const reqRank = TIER_RANK[requestedTier];

  if (reqRank > maxRank) {
    // Clamp down
    return {
      tier: policy.max_tier,
      provider_override: override,
      capped: true,
    };
  }

  return { tier: requestedTier, provider_override: override, capped: false };
}

// ---------------------------------------------------------------------------
// loadWorkspacePolicy
// ---------------------------------------------------------------------------

/**
 * Load policy from the workspace_ai_policy table.
 *
 * Table shape (created by a separate migration stream):
 *   workspace_id           text  PRIMARY KEY
 *   max_tier               text  NULL
 *   provider_override      text  NULL
 *   monthly_budget_usd     numeric NULL
 *   content_policy_profile text  NULL  (migration 231)
 *
 * Returns null when:
 *   - workspaceId is empty / whitespace
 *   - no row found for that workspace
 *   - queryFn throws or rejects
 *
 * NEVER throws.
 */
export async function loadWorkspacePolicy(
  workspaceId: string,
  queryFn: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: WorkspaceAIPolicy[] }>,
): Promise<WorkspaceAIPolicy | null> {
  if (!workspaceId || workspaceId.trim() === "") {
    return null;
  }

  try {
    const result = await queryFn(
      /* THE WHOLE ROW, not a column list, and deliberately.
         A named column that does not exist yet makes this query THROW, and
         this function catches and returns null, which reads downstream as
         "this workspace has no budget cap". So naming a new column here would
         quietly disable every spend limit in the window between a deploy and
         its migration -- the one failure this loader's fail-open posture turns
         from an error into an invisible one. The table is a single-row PK
         lookup, so selecting it whole costs nothing and cannot go stale. */
      "SELECT * FROM workspace_ai_policy WHERE workspace_id = $1 LIMIT 1",
      [workspaceId],
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// isOverBudget
// ---------------------------------------------------------------------------

/**
 * Returns true only when the workspace has a non-null monthly_budget_usd AND
 * monthSpendUsd exceeds it.
 *
 * Pure, no I/O, no time, no side-effects.
 */
export function isOverBudget(
  policy: WorkspaceAIPolicy | null,
  monthSpendUsd: number,
): boolean {
  if (!policy || policy.monthly_budget_usd === null) {
    return false;
  }
  return monthSpendUsd > policy.monthly_budget_usd;
}

// ---------------------------------------------------------------------------
// monthSpendUsd
// ---------------------------------------------------------------------------

/**
 * Sum the current calendar month's AI spend (USD) for a workspace.
 *
 * Reads `v_ai_cost_daily` (migration 166), the chargeback view aggregated
 * over the append-only `ai.completion` event stream. One column per day, so
 * we restrict to rows whose `day` falls in the current calendar month and
 * SUM(cost_usd). Calendar month (date_trunc('month', now())) rather than a
 * rolling 30-day window so the cap resets on the 1st, matching how a CFO
 * reads "monthly budget".
 *
 * Injectable queryFn keeps the helper unit-testable without a live DB and
 * mirrors loadWorkspacePolicy's dependency-injection shape.
 *
 * Returns 0 (never throws, never blocks the gateway) when:
 *   - workspaceId is empty / whitespace
 *   - no DATABASE_URL (shadow / preview) AND no queryFn was injected
 *   - the view is missing / the query throws
 *   - no rows for the workspace this month
 *
 * Returning 0 on any failure is deliberate: an unreadable cost view must
 * fail OPEN (let the call through) rather than wedge every AI call when the
 * analytics store hiccups. The hard block only fires on a *confirmed*
 * over-budget read.
 */
export async function monthSpendUsd(
  workspaceId: string,
  deps?: {
    queryFn?: (
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Array<{ month_spend_usd: number | string | null }> }>;
  },
): Promise<number> {
  if (!workspaceId || workspaceId.trim() === "") {
    return 0;
  }

  const queryFn = deps?.queryFn ?? (await defaultQueryFn());
  if (!queryFn) {
    return 0;
  }

  try {
    const result = await queryFn(
      `SELECT COALESCE(SUM(cost_usd), 0) AS month_spend_usd
         FROM v_ai_cost_daily
        WHERE workspace_id = $1
          AND day >= date_trunc('month', now())::date`,
      [workspaceId],
    );
    const raw = result.rows[0]?.month_spend_usd ?? 0;
    const spend = typeof raw === "string" ? Number(raw) : (raw ?? 0);
    return Number.isFinite(spend) && spend > 0 ? spend : 0;
  } catch {
    return 0;
  }
}

/**
 * Lazily resolve the real db query() helper. Only loaded when no queryFn is
 * injected and DATABASE_URL is present, so the pure tests never touch pg and
 * shadow/preview environments short-circuit to 0 spend.
 */
async function defaultQueryFn(): Promise<
  | ((
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Array<{ month_spend_usd: number | string | null }> }>)
  | null
> {
  if (!process.env.DATABASE_URL) return null;
  const { query } = await import("@/lib/db");
  return (sql, params) =>
    query<{ month_spend_usd: number | string | null }>(sql, params);
}

// ---------------------------------------------------------------------------
// buildPolicyEventMetadata
// ---------------------------------------------------------------------------

/**
 * Shape the metadata payload for an `ai.policy_applied` analytics event.
 *
 * The gateway emits the event; this function just builds the metadata so the
 * shape is tested and versioned here alongside the resolver.
 */
export function buildPolicyEventMetadata(
  resolved: ResolvedPolicy,
  workspaceId: string,
): {
  workspace_id: string;
  tier: ModelTier;
  capped: boolean;
  provider_override: string | null;
} {
  return {
    workspace_id: workspaceId,
    tier: resolved.tier,
    capped: resolved.capped,
    provider_override: resolved.provider_override ?? null,
  };
}
