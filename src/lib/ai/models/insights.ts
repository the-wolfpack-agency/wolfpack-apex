/**
 * What the model router has actually been doing.
 *
 * The router already chooses a model per call, logs every decision, and
 * estimates cost. None of that has ever been visible: there is no page, no
 * query, no way to answer "which models are we actually using, are the cheap
 * ones sufficing, and how often are we falling back". A routing engine nobody
 * can see is a set of defaults nobody is checking.
 *
 * This reads ai.model_selected back. It adds no new engine and no new
 * telemetry: everything here is derived from decisions the router already
 * records, which is why it costs nothing to switch on.
 *
 * ESTIMATED IS NOT BILLED, AND THE DIFFERENCE IS LOAD-BEARING
 *
 * estimated_cost_usd is list price multiplied by a token ESTIMATE made before
 * the call ran. It is not an invoice, it does not know about cached input,
 * batch discounts, or what the call actually consumed. Reporting it as spend
 * would put a number in front of someone that they would reconcile against a
 * bill and find wrong, and then they would stop trusting the whole surface.
 * Every field carrying it says "estimated" in its name, and the UI is required
 * to keep the word.
 *
 * A decision with no estimate is counted as a decision with no estimate, never
 * as zero. Zero would drag an average down and quietly understate cost.
 */
import { query } from "@/lib/db";
import { MODEL_REGISTRY, isModelAvailable } from "./registry";
import type { CapabilityTier, ModelProvider } from "./types";

export interface ModelUsage {
  modelId: string;
  provider: ModelProvider | string;
  tier: CapabilityTier | string;
  decisions: number;
  /** Decisions that carried a cost estimate. The rest are not zero-cost. */
  estimated: number;
  estimatedCostUsd: number;
  /** Times this model was chosen after a pin could not be honoured. */
  fallbacks: number;
}

export interface ReasonCount {
  reason: string;
  count: number;
  /** Plain sentence; the reason codes are not written for humans. */
  description: string;
}

export interface ModelAvailability {
  modelId: string;
  provider: ModelProvider;
  tier: CapabilityTier;
  contextWindow: number;
  inputPricePer1kUsd: number;
  outputPricePer1kUsd: number;
  available: boolean;
  /** Why it is unavailable, naming the missing configuration. */
  blockedBy: string | null;
}

export interface RouterInsights {
  days: number;
  totalDecisions: number;
  /** Sum over decisions that carried an estimate. Never billed cost. */
  estimatedCostUsd: number;
  /** Decisions with no estimate, so the total is read with the right caveat. */
  decisionsWithoutEstimate: number;
  usage: ModelUsage[];
  reasons: ReasonCount[];
  fallbacks: number;
  models: ModelAvailability[];
  /** Share of decisions served by the cheapest tier. The efficiency headline. */
  smallTierShare: number | null;
  headline: string;
}

/** Reason codes are stable machine strings; these are for people. */
const REASON_COPY: Record<string, string> = {
  agent_pin: "an agent insisted on a specific model",
  client_pin: "a client insisted on a specific model",
  workspace_pin: "the workspace default was used",
  cheapest_at_tier: "the cheapest model that met the requirement",
  downgraded_no_tier_available: "no model met the requirement, so a weaker one was used",
  no_model_available_using_default: "nothing was configured, so a default was assumed",
};

export function describeReason(reason: string): string {
  return REASON_COPY[reason] ?? reason;
}

/**
 * Which models could actually serve a request right now.
 *
 * Availability is a configuration fact, not a usage fact, so it is read from
 * the environment rather than from history. A model nobody has used is
 * available if it is configured, and a model used last week is unavailable
 * today if its key was removed — both matter and neither is visible in the
 * event stream.
 */
export function modelAvailability(env: NodeJS.ProcessEnv = process.env): ModelAvailability[] {
  return MODEL_REGISTRY.map((spec) => {
    const available = isModelAvailable(spec, env);
    let blockedBy: string | null = null;
    if (!available) {
      if (spec.provider === "openai") blockedBy = "OPENAI_API_KEY is not set";
      else if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY)
        blockedBy = "AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY is not set";
      else if (spec.deploymentEnvVar) blockedBy = `${spec.deploymentEnvVar} is not set`;
      else blockedBy = "not configured";
    }
    return {
      modelId: spec.id,
      provider: spec.provider,
      tier: spec.capabilityTier,
      contextWindow: spec.contextWindow,
      inputPricePer1kUsd: spec.inputPricePer1kUsd,
      outputPricePer1kUsd: spec.outputPricePer1kUsd,
      available,
      blockedBy,
    };
  }).sort((a, b) => Number(b.available) - Number(a.available) || a.modelId.localeCompare(b.modelId));
}

interface DecisionRow extends Record<string, unknown> {
  model_id: string | null;
  provider: string | null;
  tier: string | null;
  reason: string | null;
  estimated_cost_usd: string | null;
  fallback_from: string | null;
}

/** Fold decision rows into usage and reason breakdowns. Pure, so every rule is
 *  testable without a database. */
export function summarizeDecisions(rows: DecisionRow[]): {
  usage: ModelUsage[];
  reasons: ReasonCount[];
  totalDecisions: number;
  estimatedCostUsd: number;
  decisionsWithoutEstimate: number;
  fallbacks: number;
  smallTierShare: number | null;
} {
  const byModel = new Map<string, ModelUsage>();
  const byReason = new Map<string, number>();
  let estimatedCostUsd = 0;
  let decisionsWithoutEstimate = 0;
  let fallbacks = 0;
  let smallTier = 0;
  let total = 0;

  for (const row of rows) {
    const modelId = row.model_id;
    if (!modelId) continue;
    total += 1;

    const entry =
      byModel.get(modelId) ??
      {
        modelId,
        provider: row.provider ?? "unknown",
        tier: row.tier ?? "unknown",
        decisions: 0,
        estimated: 0,
        estimatedCostUsd: 0,
        fallbacks: 0,
      };
    entry.decisions += 1;

    // A number that will not parse is a MISSING estimate, not a zero one.
    const cost = row.estimated_cost_usd === null ? Number.NaN : Number(row.estimated_cost_usd);
    if (Number.isFinite(cost)) {
      entry.estimated += 1;
      entry.estimatedCostUsd += cost;
      estimatedCostUsd += cost;
    } else {
      decisionsWithoutEstimate += 1;
    }

    if (row.fallback_from) {
      entry.fallbacks += 1;
      fallbacks += 1;
    }
    if (row.tier === "small") smallTier += 1;

    byModel.set(modelId, entry);
    const reason = row.reason ?? "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  return {
    usage: [...byModel.values()].sort((a, b) => b.decisions - a.decisions || a.modelId.localeCompare(b.modelId)),
    reasons: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count, description: describeReason(reason) }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    totalDecisions: total,
    // Rounded to the cent it is quoted in; carrying float noise into a money
    // figure makes it look more precise than an estimate deserves.
    estimatedCostUsd: Math.round(estimatedCostUsd * 10_000) / 10_000,
    decisionsWithoutEstimate,
    fallbacks,
    smallTierShare: total === 0 ? null : smallTier / total,
  };
}

/** One line for the top of the page. Names what is NOT known. */
export function describeInsights(s: {
  totalDecisions: number;
  smallTierShare: number | null;
  fallbacks: number;
  decisionsWithoutEstimate: number;
}): string {
  if (s.totalDecisions === 0) {
    return "No routing decisions have been recorded yet, so there is nothing to measure.";
  }
  const parts = [`${s.totalDecisions} routing decision${s.totalDecisions === 1 ? "" : "s"}`];
  if (s.smallTierShare !== null) {
    parts.push(`${Math.round(s.smallTierShare * 100)}% served by the cheapest tier`);
  }
  if (s.fallbacks > 0) {
    parts.push(`${s.fallbacks} fell back because a preferred model was unavailable`);
  }
  if (s.decisionsWithoutEstimate > 0) {
    parts.push(`${s.decisionsWithoutEstimate} carried no cost estimate, so the total below understates the true figure`);
  }
  return `${parts.join(", ")}.`;
}

/**
 * Router activity over the last N days.
 *
 * Availability is always returned, even when history cannot be read: "which
 * models are configured" is answerable from the environment alone, and it is
 * the more actionable half. A failed read yields zero decisions, which the
 * headline reports as "nothing recorded" rather than as "nothing happened".
 */
export async function getRouterInsights(days = 30): Promise<RouterInsights> {
  const models = modelAvailability();
  let rows: DecisionRow[] = [];

  if (process.env.DATABASE_URL) {
    try {
      const result = await query<DecisionRow>(
        `SELECT metadata->>'model_id'            AS model_id,
                metadata->>'provider'            AS provider,
                metadata->>'tier'                AS tier,
                metadata->>'reason'              AS reason,
                metadata->>'estimated_cost_usd'  AS estimated_cost_usd,
                metadata->>'fallback_from'       AS fallback_from
           FROM instinct_events
          WHERE event_type = 'ai.model_selected'
            AND timestamp > NOW() - INTERVAL '1 day' * $1
          ORDER BY timestamp DESC
          LIMIT 20000`,
        [days],
      );
      rows = result.rows;
    } catch {
      /* A panel must not take the page down. Zero decisions, reported as such. */
    }
  }

  const s = summarizeDecisions(rows);
  return { days, models, ...s, headline: describeInsights(s) };
}
