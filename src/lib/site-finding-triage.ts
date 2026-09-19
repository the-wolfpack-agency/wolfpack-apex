/**
 * Triage state for Site Analytics agent-journey findings. Turns the triage board
 * into a workflow with memory: an operator acknowledges a finding, escalates a
 * real threat, or dismisses a false positive, and that decision persists.
 *
 * Workspace-scoped (every read + write filters by workspace_id). No PII: the
 * finding_key is the opaque journey correlation key, never a person. Reads use
 * safeQuery so a DB hiccup degrades to "no triage state", never a broken page.
 */

import { query, safeQuery } from "@/lib/db";

export type TriageStatus = "new" | "acknowledged" | "escalated" | "dismissed";

export const TRIAGE_STATUSES: readonly TriageStatus[] = ["new", "acknowledged", "escalated", "dismissed"];

export function isTriageStatus(v: unknown): v is TriageStatus {
  return typeof v === "string" && (TRIAGE_STATUSES as readonly string[]).includes(v);
}

export interface TriageRecord {
  status: TriageStatus;
  note: string | null;
  updatedAt: string;
}

/**
 * Upsert a finding's triage state. Setting "new" clears any note but keeps the
 * row (so the transition is auditable). Idempotent per (workspace, finding).
 */
export async function setFindingTriage(input: {
  workspaceId: string;
  findingKey: string;
  status: TriageStatus;
  note?: string | null;
  updatedBy: string;
}): Promise<void> {
  await query(
    `INSERT INTO instinct_site_finding_triage (workspace_id, finding_key, status, note, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, finding_key)
     DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [input.workspaceId, input.findingKey, input.status, input.note ?? null, input.updatedBy],
  );
}

/**
 * Fetch triage state for a workspace, optionally narrowed to a set of finding
 * keys (the journeys currently on screen). Returns a map keyed by finding key.
 */
export async function getFindingTriage(
  workspaceId: string,
  findingKeys?: readonly string[],
): Promise<Record<string, TriageRecord>> {
  const rows =
    findingKeys && findingKeys.length > 0
      ? await safeQuery<{ finding_key: string; status: string; note: string | null; updated_at: string }>(
          `SELECT finding_key, status, note, updated_at::text AS updated_at
             FROM instinct_site_finding_triage
            WHERE workspace_id = $1 AND finding_key = ANY($2)`,
          [workspaceId, findingKeys as string[]],
        )
      : await safeQuery<{ finding_key: string; status: string; note: string | null; updated_at: string }>(
          `SELECT finding_key, status, note, updated_at::text AS updated_at
             FROM instinct_site_finding_triage
            WHERE workspace_id = $1
            ORDER BY updated_at DESC LIMIT 500`,
          [workspaceId],
        );

  const map: Record<string, TriageRecord> = {};
  for (const r of rows.rows) {
    if (isTriageStatus(r.status)) map[r.finding_key] = { status: r.status, note: r.note, updatedAt: r.updated_at };
  }
  return map;
}
