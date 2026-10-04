/**
 * Factory brain #8: repair recipes - which gate-block CATEGORIES the Stage-2
 * auto-fix loop reliably resolves vs which end at a human. Metadata only (a
 * category label + counts), so it can never hold code or a secret.
 *
 * Best-effort + never throws: this is learning telemetry; a store hiccup must
 * never break a run or the gate.
 */
import { query, safeQuery } from "@/lib/db";

/** The gate block categories the repair loop reports (from assess.blockedBy). */
export type BlockCategory = "security" | "invariant" | "deep-scan";
const CATEGORIES: readonly string[] = ["security", "invariant", "deep-scan"];

export interface RepairEfficacyRow {
  category: string;
  runs: number;
  resolved: number;
  /** resolved / runs - how often Stage-2 repair cleared this block without a human. */
  resolveRate: number;
}
export interface RepairEfficacy {
  windowDays: number;
  byCategory: RepairEfficacyRow[];
}

/**
 * Record one Stage-2 repair outcome. No-op when there was no block to repair
 * (blockedBy null/unknown). Never throws. Returns whether a row was written.
 */
export async function recordRepairOutcome(args: {
  workspaceId: string;
  repo: string;
  blockedBy: string | null | undefined;
  attempts: number;
  resolved: boolean;
}): Promise<{ written: number }> {
  const cat = typeof args.blockedBy === "string" ? args.blockedBy : "";
  if (!CATEGORIES.includes(cat)) return { written: 0 };
  try {
    await query(
      `INSERT INTO instinct_factory_repair_recipes (workspace_id, repo, blocked_by, attempts, resolved)
         VALUES ($1, $2, $3, $4, $5)`,
      [args.workspaceId, args.repo, cat, Math.max(0, Math.trunc(args.attempts) || 0), args.resolved === true],
    );
    return { written: 1 };
  } catch {
    return { written: 0 };
  }
}

/** Fold rows into per-category resolve rates, most runs first. Pure. */
export function summarizeRepairEfficacy(
  rows: readonly { blocked_by: string; runs: number; resolved: number }[],
  windowDays: number,
): RepairEfficacy {
  const byCategory = rows
    .map((r) => {
      const runs = Number(r.runs) || 0;
      const resolved = Number(r.resolved) || 0;
      return { category: r.blocked_by, runs, resolved, resolveRate: runs > 0 ? resolved / runs : 0 };
    })
    .filter((r) => r.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.category.localeCompare(b.category));
  return { windowDays, byCategory };
}

/** Per-category repair efficacy for a workspace over `days`. Never throws -> []. */
export async function loadRepairEfficacy(workspaceId: string, days: number): Promise<RepairEfficacy> {
  const d = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 30;
  const { rows } = await safeQuery<{ blocked_by: string; runs: number; resolved: number }>(
    `SELECT blocked_by,
            count(*)::int AS runs,
            count(*) FILTER (WHERE resolved)::int AS resolved
       FROM instinct_factory_repair_recipes
      WHERE workspace_id = $1 AND created_at > now() - ($2 || ' days')::interval
      GROUP BY blocked_by`,
    [workspaceId, String(d)],
  );
  return summarizeRepairEfficacy(rows, d);
}
