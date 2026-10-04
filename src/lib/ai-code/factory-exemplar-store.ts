/**
 * Factory brain #10: EXEMPLARS - pointers to factory changes a human MERGED, used
 * to ground future authoring in work that actually shipped (and which model
 * shipped it). Recorded at handoff keyed by approval_id, promoted to merged by the
 * merge-poll. Safe by construction: a reference + prompt + model, never the code.
 *
 * Every function is best-effort and NEVER throws - exemplars are learning
 * telemetry, so a store hiccup must never break a run or the merge poll.
 */
import { query, safeQuery } from "@/lib/db";

/** Keep a stored prompt bounded so one row can't be huge. */
export const MAX_EXEMPLAR_PROMPT = 2000;
/** Default number of exemplars to surface when grounding authoring. */
export const EXEMPLAR_LIMIT = 3;

export interface Exemplar {
  repo: string;
  taskType: string;
  prompt: string;
  model: string;
}

/** Trim + clamp a prompt for storage/grounding. Pure. */
export function clampPrompt(prompt: string, max = MAX_EXEMPLAR_PROMPT): string {
  const t = (prompt ?? "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Record a (pending) exemplar for a handoff. ON CONFLICT DO NOTHING so a retry is
 * idempotent. merged stays false until the merge-poll promotes it. Never throws.
 */
export async function recordExemplar(args: {
  workspaceId: string;
  approvalId: string;
  repo: string;
  taskType: string;
  prompt: string;
  model: string;
}): Promise<{ written: number }> {
  if (!args.approvalId) return { written: 0 };
  try {
    await query(
      `INSERT INTO instinct_factory_exemplars (workspace_id, approval_id, repo, task_type, prompt, model)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, approval_id) DO NOTHING`,
      [args.workspaceId, args.approvalId, args.repo, args.taskType || "other", clampPrompt(args.prompt), args.model || ""],
    );
    return { written: 1 };
  } catch {
    return { written: 0 };
  }
}

/**
 * Promote an exemplar to merged (the human-merged positive signal). Idempotent:
 * only flips a not-yet-merged row. Returns how many rows changed. Never throws.
 */
export async function markExemplarMerged(workspaceId: string, approvalId: string): Promise<{ merged: number }> {
  if (!approvalId) return { merged: 0 };
  try {
    const { rowCount } = await query(
      `UPDATE instinct_factory_exemplars
          SET merged = true, merged_at = now()
        WHERE workspace_id = $1 AND approval_id = $2 AND merged = false`,
      [workspaceId, approvalId],
    );
    return { merged: rowCount ?? 0 };
  } catch {
    return { merged: 0 };
  }
}

/**
 * The most recent MERGED exemplars for a task type (the positive signal only).
 * [] on any failure. Workspace + task scoped.
 */
export async function loadExemplars(workspaceId: string, taskType: string, limit = EXEMPLAR_LIMIT): Promise<Exemplar[]> {
  const n = Number.isInteger(limit) && limit > 0 && limit <= 20 ? limit : EXEMPLAR_LIMIT;
  const { rows } = await safeQuery<{ repo: string; task_type: string; prompt: string; model: string }>(
    `SELECT repo, task_type, prompt, model
       FROM instinct_factory_exemplars
      WHERE workspace_id = $1 AND task_type = $2 AND merged = true
      ORDER BY created_at DESC
      LIMIT ${n}`,
    [workspaceId, taskType || "other"],
  );
  return rows.map((r) => ({ repo: r.repo, taskType: r.task_type, prompt: r.prompt, model: r.model }));
}

/**
 * A short author-prompt grounding block from merged exemplars. Pure. "" when none,
 * so it contributes nothing to the prompt (and no "examples" header appears).
 */
export function buildExemplarBlock(exemplars: readonly Exemplar[]): string {
  if (!exemplars.length) return "";
  const lines = exemplars.map((e) => {
    const oneLine = e.prompt.replace(/\s+/g, " ").trim().slice(0, 160);
    return `- [${e.taskType}] shipped via ${e.model || "a model"}: "${oneLine}"`;
  });
  return [
    "SHIPPED EXAMPLES (similar factory work that passed the gate and a human merged):",
    ...lines,
    "Prefer the structure and conventions these used; they are known-good in this codebase.",
  ].join("\n");
}
