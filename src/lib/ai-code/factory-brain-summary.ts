/**
 * Factory brain: ONE headline read-model over every learning signal, so an operator
 * sees at a glance whether the factory is actually improving over time.
 *
 * Composes the per-signal loaders (each already never-throws) + two best-effort
 * direct counts (exemplars, corrections). Every piece is independently guarded, so
 * a cold/absent table degrades that tile to null rather than breaking the summary -
 * safe to ship before the newest tables have deployed or accrued data.
 */
import { safeQuery } from "@/lib/db";
import { loadLoopEfficacy } from "./loop-efficacy";
import { loadGatePrecision } from "./gate-precision";
import { loadTaskTypeGrades } from "./task-type";
import { loadRepairEfficacy } from "./factory-repair-recipes";
import { countReuseCorpus } from "./factory-reuse-store";
import { countFailures } from "./factory-failure-store";

export interface BrainSummary {
  windowDays: number;
  /** The learned corpora the brain draws on. */
  memory: { reuse: number; failures: number; exemplars: number };
  /** Is first-pass quality rising? (null until there are runs.) */
  improving: { firstPassReadyRate: number | null; acceptanceRate: number | null; trend: string; runs: number };
  /** Gate precision: the overall human-labeled false-positive rate (null = no labels). */
  precision: { wrongRate: number | null; reviewed: number };
  /** Stage-2 auto-fix: share of gate blocks resolved without a human (null = none). */
  repair: { resolveRate: number | null; runs: number };
  /** Model grades: how many (model, task-type) cells we have a read on. */
  grades: { cells: number };
  /** Human corrections: how often a merged PR still needed a human edit (null = none). */
  corrections: { editRate: number | null; merged: number };
}

async function countScoped(table: string, workspaceId: string, extra = ""): Promise<number> {
  // table is a fixed internal identifier (never user input); workspace_id is bound.
  const { rows } = await safeQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1 ${extra}`,
    [workspaceId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function loadBrainSummary(workspaceId: string, days = 30): Promise<BrainSummary> {
  const d = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 30;
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };

  const [reuse, failures, exemplars, efficacy, precision, repair, grades, corr] = await Promise.all([
    safe(countReuseCorpus(workspaceId), 0),
    safe(countFailures(workspaceId), 0),
    safe(countScoped("instinct_factory_exemplars", workspaceId, "AND merged = true"), 0),
    safe(loadLoopEfficacy(workspaceId, d), null),
    safe(loadGatePrecision(workspaceId, d), null),
    safe(loadRepairEfficacy(workspaceId, d), null),
    safe(loadTaskTypeGrades(workspaceId, d), null),
    safe(
      safeQuery<{ total: number; edited: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE edited)::int AS edited
           FROM instinct_factory_corrections
          WHERE workspace_id = $1 AND created_at > now() - ($2 || ' days')::interval`,
        [workspaceId, String(d)],
      ).then((r) => r.rows[0] ?? { total: 0, edited: 0 }),
      { total: 0, edited: 0 },
    ),
  ]);

  // Overall gate false-positive rate = wrong / reviewed across all classes.
  let wrong = 0, reviewed = 0;
  for (const c of precision?.classes ?? []) { wrong += c.wrong; reviewed += c.reviewed; }
  // Overall repair resolve rate = resolved / runs across all categories.
  let rResolved = 0, rRuns = 0;
  for (const c of repair?.byCategory ?? []) { rResolved += c.resolved; rRuns += c.runs; }

  return {
    windowDays: d,
    memory: { reuse, failures, exemplars },
    improving: {
      firstPassReadyRate: efficacy?.firstPassReadyRate ?? null,
      acceptanceRate: efficacy?.acceptanceRate ?? null,
      trend: efficacy?.readyTrend ?? "n/a",
      runs: efficacy?.runs ?? 0,
    },
    precision: { wrongRate: reviewed > 0 ? wrong / reviewed : null, reviewed },
    repair: { resolveRate: rRuns > 0 ? rResolved / rRuns : null, runs: rRuns },
    grades: { cells: grades?.byModelTask?.length ?? 0 },
    corrections: { editRate: corr.total > 0 ? corr.edited / corr.total : null, merged: corr.total },
  };
}
