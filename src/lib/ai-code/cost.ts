/**
 * Cost meter for the factory: what a run actually cost, and what the SAME token
 * usage would have cost on other popular models. Same manner as the model router
 * meter, and it reuses the one pricing source (MODEL_REGISTRY) so a factory
 * estimate and a router estimate can never drift.
 *
 * Deterministic: list price times measured tokens. No model call.
 */
import { MODEL_REGISTRY } from "@/lib/ai/models/registry";
import type { ModelSpec } from "@/lib/ai/models/types";

/** USD formatter matching the router meter: 4dp for sub-cent, else 2dp. */
export function usd(n: number): string {
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** Cost of a given token split on one model's list price. */
export function costOnModel(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * spec.inputPricePer1kUsd + (outputTokens / 1000) * spec.outputPricePer1kUsd;
}

export interface ModelCostRow {
  model: string;
  provider: string;
  tier: string;
  costUsd: number;
}

/**
 * What the run's token usage would cost across popular models, cheapest first.
 * One row per DISTINCT base model (the Azure mirror of a model is folded into the
 * same price, so the table reads as "gpt-4o-mini", not two identical rows).
 */
export function compareModelCosts(inputTokens: number, outputTokens: number): ModelCostRow[] {
  const seen = new Set<string>();
  const rows: ModelCostRow[] = [];
  for (const spec of MODEL_REGISTRY) {
    // Fold azure-<x> into <x> so the comparison is by model, not by hosting.
    const base = spec.id.replace(/^azure-/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    rows.push({
      model: base,
      provider: spec.provider,
      tier: spec.capabilityTier,
      costUsd: costOnModel(spec, inputTokens, outputTokens),
    });
  }
  return rows.sort((a, b) => a.costUsd - b.costUsd);
}

export interface RunCost {
  /** Billed cost of the run (executor + any repair re-authors we could measure). */
  actualUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Model attempts made: 1 (executor) + repair re-authors. Iteration overhead is
   *  the hidden cost of a cheaper model that needs more passes. */
  attempts: number;
  /** What this token usage would cost on other popular models (cheapest first). */
  comparison: ModelCostRow[];
}

/** Assemble the run cost from the executor's measured usage + repair attempts. */
export function buildRunCost(args: {
  actualUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  repairAttempts: number;
}): RunCost {
  const inputTokens = args.inputTokens ?? 0;
  const outputTokens = args.outputTokens ?? 0;
  return {
    actualUsd: args.actualUsd ?? 0,
    inputTokens,
    outputTokens,
    attempts: 1 + Math.max(0, args.repairAttempts),
    comparison: compareModelCosts(inputTokens, outputTokens),
  };
}
