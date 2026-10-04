/**
 * Factory brain #3: correction memory store. Persists the DETERMINISTIC correction
 * analysis (categories + counts) per handoff and reads back, per task type, how
 * often humans had to edit + which categories dominate. Metadata only - never the
 * delta code. Best-effort; never throws.
 */
import { query, safeQuery } from "@/lib/db";
import type { CorrectionAnalysis } from "./factory-correction-analysis";

export interface CorrectionSignals {
  taskType: string;
  /** Merged handoffs of this task type observed. */
  total: number;
  /** Fraction that a human had to edit before merge. */
  editRate: number;
  /** Category -> fraction of edited handoffs that needed it, strongest first. */
  categories: { category: string; rate: number }[];
}

/** Record one correction analysis for a merged handoff. Idempotent. Never throws. */
export async function recordCorrection(args: {
  workspaceId: string;
  approvalId: string;
  repo: string;
  taskType: string;
  analysis: CorrectionAnalysis;
}): Promise<{ written: number }> {
  if (!args.approvalId) return { written: 0 };
  try {
    await query(
      `INSERT INTO instinct_factory_corrections
         (workspace_id, approval_id, repo, task_type, edited, categories, human_added, human_removed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, approval_id) DO NOTHING`,
      [
        args.workspaceId, args.approvalId, args.repo, args.taskType || "other",
        args.analysis.edited, args.analysis.categories,
        Math.max(0, args.analysis.humanAdded | 0), Math.max(0, args.analysis.humanRemoved | 0),
      ],
    );
    return { written: 1 };
  } catch {
    return { written: 0 };
  }
}

/**
 * Per-task-type correction signals for a workspace over `days`: how often a human
 * had to edit, and which categories dominate the edits. [] shape on any failure.
 */
export async function loadCorrectionSignals(workspaceId: string, taskType: string, days = 90): Promise<CorrectionSignals> {
  const empty: CorrectionSignals = { taskType: taskType || "other", total: 0, editRate: 0, categories: [] };
  const d = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 90;
  try {
    const { rows } = await safeQuery<{ edited: boolean; categories: string[] }>(
      `SELECT edited, categories FROM instinct_factory_corrections
        WHERE workspace_id = $1 AND task_type = $2 AND created_at > now() - ($3 || ' days')::interval`,
      [workspaceId, taskType || "other", String(d)],
    );
    if (rows.length === 0) return empty;
    const total = rows.length;
    const editedRows = rows.filter((r) => r.edited === true);
    const counts = new Map<string, number>();
    for (const r of editedRows) for (const c of r.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    const denom = editedRows.length || 1;
    const categories = [...counts.entries()]
      .map(([category, n]) => ({ category, rate: n / denom }))
      .sort((a, b) => b.rate - a.rate || a.category.localeCompare(b.category));
    return { taskType: taskType || "other", total, editRate: editedRows.length / total, categories };
  } catch {
    return empty;
  }
}
