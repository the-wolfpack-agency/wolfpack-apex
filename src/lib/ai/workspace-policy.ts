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
 *   workspace_id       text  PRIMARY KEY
 *   max_tier           text  NULL
 *   provider_override  text  NULL
 *   monthly_budget_usd numeric NULL
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
      "SELECT workspace_id, max_tier, provider_override, monthly_budget_usd FROM workspace_ai_policy WHERE workspace_id = $1 LIMIT 1",
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
