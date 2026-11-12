/**
 * Per-tenant AI cost + usage metering - the managed-LLM COGS instrument.
 *
 * Aggregates the v_ai_cost_daily view (migration 166), which sums the router's
 * recorded cost_usd + tokens per workspace/model from the ai.completion event
 * stream. The cost is what the router recorded per call (provider-billed, not an
 * estimate), so this is what a tenant actually cost us to serve - the number
 * that makes "offer managed LLMs" a priceable option rather than a guess, and
 * that flags a heavy tenant before it erodes margin.
 *
 * The DB read is injected so the aggregation is unit-testable with no DB;
 * liveCostDeps wires the real query over the view.
 */
import { safeQuery } from "@/lib/db";

export interface CostByModel {
  model: string;
  provider: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostReport {
  sinceIso: string;
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: CostByModel[];
}

export interface CostDeps {
  /** Per-model cost rows for the workspace since `sinceIso`, newest spend first. */
  loadByModel: (workspaceId: string, sinceIso: string) => Promise<CostByModel[]>;
}

export function liveCostDeps(): CostDeps {
  return {
    loadByModel: async (workspaceId, sinceIso) => {
      const res = await safeQuery<{
        model: string;
        provider: string;
        calls: string | number;
        cost_usd: string | number;
        input_tokens: string | number;
        output_tokens: string | number;
      }>(
        `SELECT model, provider,
                SUM(calls)::bigint         AS calls,
                SUM(cost_usd)::numeric     AS cost_usd,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens
           FROM v_ai_cost_daily
          WHERE workspace_id = $1 AND day >= $2::date
          GROUP BY model, provider
          ORDER BY cost_usd DESC`,
        [workspaceId, sinceIso.slice(0, 10)],
      );
      return res.rows.map((r) => ({
        model: r.model,
        provider: r.provider,
        calls: Number(r.calls) || 0,
        costUsd: Number(r.cost_usd) || 0,
        inputTokens: Number(r.input_tokens) || 0,
        outputTokens: Number(r.output_tokens) || 0,
      }));
    },
  };
}

export async function computeCostUsage(
  workspaceId: string,
  sinceIso: string,
  deps: CostDeps,
): Promise<CostReport> {
  const byModel = await deps.loadByModel(workspaceId, sinceIso);
  return {
    sinceIso,
    totalCostUsd: round4(byModel.reduce((n, m) => n + m.costUsd, 0)),
    totalCalls: byModel.reduce((n, m) => n + m.calls, 0),
    totalInputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
    totalOutputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
    byModel,
  };
}

/** Money rounded to 4 dp - sub-cent per-call costs still add up honestly. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
