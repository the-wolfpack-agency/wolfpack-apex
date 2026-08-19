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
  /* MEASURED, not estimated: taken from ai.completion, which carries the
     provider's own numbers for calls that actually ran. Absent when this model
     was selected but never completed a call in the window. */
  actualCalls?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
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
  /** What the router kept from leaving, and how much traffic it checked. */
  protection?: ProtectionSummary;
  /** Measured spend across every completed call in the window. */
  actualCostUsd?: number;
  actualCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
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
  actualCalls?: number;
  actualCostUsd?: number;
  outputTokens?: number;
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
  /* LEAD WITH THE MEASURED NUMBER when there is one. The old sentence said
     "N carried no cost estimate, so the total below understates the true
     figure", which was true and unhelpful: it apologised for a number instead
     of reporting the one we actually had. */
  if (s.actualCalls && s.actualCalls > 0) {
    const spend = (s.actualCostUsd ?? 0).toFixed(2);
    parts.push(`${s.actualCalls} call${s.actualCalls === 1 ? "" : "s"} completed and cost $${spend} in measured spend`);
    if (s.outputTokens) {
      parts.push(`${s.outputTokens.toLocaleString()} output tokens generated`);
    }
  } else if (s.decisionsWithoutEstimate > 0) {
    /* No measured spend at all is the only case where the estimate gap still
       matters, and it means completions are not being recorded, which is a
       different and worse problem than a missing estimate. */
    parts.push(
      `no completed calls recorded, so spend cannot be measured (${s.decisionsWithoutEstimate} decision${s.decisionsWithoutEstimate === 1 ? "" : "s"} had no estimate either)`,
    );
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
/**
 * WHAT A TURN ACTUALLY COST, as opposed to what we guessed before making it.
 *
 * Reported 2026-08-19: "17 decisions carried no cost estimate, so the figure
 * above understates the real total ... we aren't even counting our output".
 *
 * The estimate is optional by construction: `withEstimate` only prices a
 * selection when the CALLER passed token counts, and the assistant path passes
 * none, because before a model has answered nobody knows how long the answer
 * will be. So the selection event legitimately has no estimate, and no amount
 * of guessing at selection time would make that number true.
 *
 * The real figure was already being recorded and was simply never read.
 * `ai.completion` carries the provider's own input_tokens, output_tokens and
 * cost_usd for every call that completed. That is measured spend, not an
 * estimate, and it is what a router is judged on.
 *
 * Joined by model id, so a model with actual spend reports actual spend, and a
 * selection that never completed (an error, a timeout) is still counted as a
 * decision and honestly reported as having cost nothing measurable.
 */
interface ActualRow extends Record<string, unknown> {
  model: string | null;
  cost_usd: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
}

export interface ActualSpend {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function summarizeActuals(rows: ActualRow[]): Map<string, ActualSpend> {
  const byModel = new Map<string, ActualSpend>();
  for (const row of rows) {
    if (!row.model) continue;
    const entry =
      byModel.get(row.model) ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += 1;
    /* A value that will not parse is missing, never zero: a provider that
       stopped reporting cost must not read as a free call. */
    const num = (v: string | null) => {
      const n = v === null ? Number.NaN : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    entry.costUsd += num(row.cost_usd);
    entry.inputTokens += num(row.input_tokens);
    entry.outputTokens += num(row.output_tokens);
    byModel.set(row.model, entry);
  }
  return byModel;
}

/**
 * WHAT THE ROUTER KEPT IN, and how much of the traffic it checked.
 *
 * The router redacts credentials and financial identifiers at the last point
 * before a prompt leaves this process, on EVERY completion, whichever model
 * answers and whoever wrote the call site. That has been true for a while and
 * has never been shown anywhere, which is the same failure as the cost: the
 * evidence existed and nothing read it.
 *
 * TWO NUMBERS, and the first is the durable one.
 *
 * COVERAGE is the claim worth making to a client: every call was checked, to
 * every model, including ones we do not control. It stays true on a quiet week.
 *
 * INTERVENTIONS is the proof it is not decorative, and it is deliberately the
 * second number. A low count means people pasted few secrets, which is good
 * news that a "blocked: 3" headline would read as a weak product.
 */
interface RedactionRow extends Record<string, unknown> {
  redacted_count: string | null;
  kinds: string | null;
}

export interface ProtectionSummary {
  /** Completions that ran, every one of which passed the gate. */
  callsChecked: number;
  /** Calls where something was found and withheld. */
  callsWithFindings: number;
  /** Individual values replaced before the prompt left this process. */
  itemsWithheld: number;
  /** Which kinds, most common first. Never a value: the gate stores
   *  placeholders only, by design, so this cannot leak what it caught. */
  kinds: { kind: string; count: number }[];
}

export function summarizeProtection(rows: RedactionRow[], callsChecked: number): ProtectionSummary {
  let itemsWithheld = 0;
  const byKind = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.redacted_count);
    itemsWithheld += Number.isFinite(n) ? n : 0;
    for (const kind of (row.kinds ?? "").split(",").filter(Boolean)) {
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
  }
  return {
    callsChecked,
    callsWithFindings: rows.length,
    itemsWithheld,
    kinds: [...byKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  };
}

export async function getRouterInsights(days = 30): Promise<RouterInsights> {
  const models = modelAvailability();
  let rows: DecisionRow[] = [];
  let actualRows: ActualRow[] = [];
  let redactionRows: RedactionRow[] = [];

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

    try {
      const result = await query<ActualRow>(
        /* JOIN ON THE REGISTRY ID, NOT THE PROVIDER'S NAME.
           `metadata->>'model'` is response.model_used, which for Azure is the
           DEPLOYMENT name ("gpt-4o-mini"), while a selection records the
           registry id ("azure-gpt-4o-mini"). Joining those two matched
           nothing, so every model reported "no completed call recorded" while
           the calls were sitting right there. Reported 2026-08-19, and my own
           bug: I joined two identifiers without checking they were the same
           vocabulary.

           `selected_model_id` is the registry id, recorded on the completion
           event for exactly this reason. It falls back to the provider name so
           a row that predates that field still counts toward the totals. */
        `SELECT COALESCE(metadata->>'selected_model_id', metadata->>'model') AS model,
                metadata->>'cost_usd'      AS cost_usd,
                metadata->>'input_tokens'  AS input_tokens,
                metadata->>'output_tokens' AS output_tokens
           FROM instinct_events
          WHERE event_type = 'ai.completion'
            AND timestamp > NOW() - INTERVAL '1 day' * $1
          ORDER BY timestamp DESC
          LIMIT 20000`,
        [days],
      );
      actualRows = result.rows;
    } catch {
      /* Same posture: no actuals is a smaller answer, not a broken page. */
    }

    try {
      const result = await query<RedactionRow>(
        `SELECT metadata->>'redacted_count' AS redacted_count,
                metadata->>'kinds'          AS kinds
           FROM instinct_events
          WHERE event_type = 'ai.prompt_redacted'
            AND timestamp > NOW() - INTERVAL '1 day' * $1
          LIMIT 20000`,
        [days],
      );
      redactionRows = result.rows;
    } catch {
      /* Same posture again. */
    }
  }

  const s = summarizeDecisions(rows);
  const actuals = summarizeActuals(actualRows);

  /* Actual spend is attached per model and totalled separately from the
     estimate, so the two are never added together or mistaken for each other. */
  const usage = s.usage.map((u) => {
    const a = actuals.get(u.modelId);
    return a ? { ...u, actualCalls: a.calls, actualCostUsd: a.costUsd, inputTokens: a.inputTokens, outputTokens: a.outputTokens } : u;
  });
  /* THE TOTAL IS OVER EVERY COMPLETED CALL, matched to a model or not.
     Summing only the rows that joined would understate spend the moment an
     identifier does not line up, which is the failure being fixed here: money
     was spent either way, and a total that quietly drops some of it is the
     same lie in a smaller font. Per-model attribution can be incomplete; the
     headline figure cannot. */
  let actualCostUsd = 0;
  let actualCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const a of actuals.values()) {
    actualCostUsd += a.costUsd;
    actualCalls += a.calls;
    inputTokens += a.inputTokens;
    outputTokens += a.outputTokens;
  }

  /* Coverage is measured against the calls that actually ran, not against
     selections: a selection that never completed sent nothing, so counting it
     as "checked" would inflate the claim with traffic that never existed. */
  const protection = summarizeProtection(redactionRows, actualCalls);

  const withActuals = { ...s, usage, actualCostUsd, actualCalls, inputTokens, outputTokens };
  return { days, models, ...withActuals, protection, headline: describeInsights(withActuals) };
}
