/**
 * Persistence for automation recommendations. Upserts on
 * (workspace, platform, key): re-running the engine refreshes content but
 * PRESERVES human triage (status/decided_*), mirroring the findings store so a
 * dismissed/accepted proposal never silently reverts to "proposed". Degrades
 * safely with no DB.
 */
import { safeQuery, writeQuery } from "@/lib/db";
import type { AutomationRecommendation, RecStatus, RecPriority, RecCategory } from "./types";

export interface RecommendationRow extends AutomationRecommendation {
  id: string;
  platform: string;
  status: RecStatus;
  createdAt: string;
  /** The review-gated remediation PR opened for this recommendation, if any. */
  prUrl?: string | null;
}

export async function saveRecommendations(
  workspaceId: string,
  platform: string,
  recs: AutomationRecommendation[],
): Promise<number> {
  for (const r of recs) {
    await writeQuery(
      `INSERT INTO instinct_automation_recommendations
         (workspace_id, platform, key, category, priority, title, rationale, suggested_action, source, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (workspace_id, platform, key) DO UPDATE SET
         category = EXCLUDED.category,
         priority = EXCLUDED.priority,
         title = EXCLUDED.title,
         rationale = EXCLUDED.rationale,
         suggested_action = EXCLUDED.suggested_action,
         source = EXCLUDED.source,
         evidence = EXCLUDED.evidence`,
      [workspaceId, platform, r.key, r.category, r.priority, r.title, r.rationale, r.suggestedAction, r.source, JSON.stringify(r.evidence)],
    );
  }
  return recs.length;
}

interface DbRow {
  id: string;
  platform: string;
  key: string;
  category: string;
  priority: string;
  title: string;
  rationale: string;
  suggested_action: string;
  source: string;
  evidence: Record<string, string | number | boolean | null> | string;
  status: string;
  created_at: string | Date;
  pr_url?: string | null;
}

function toRow(r: DbRow): RecommendationRow {
  return {
    id: String(r.id),
    platform: String(r.platform),
    key: String(r.key),
    category: String(r.category) as RecCategory,
    priority: String(r.priority) as RecPriority,
    title: String(r.title),
    rationale: String(r.rationale),
    suggestedAction: String(r.suggested_action),
    source: String(r.source),
    evidence: typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence,
    status: String(r.status) as RecStatus,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    prUrl: r.pr_url ?? null,
  };
}

export async function listRecommendations(
  workspaceId: string,
  opts?: { platform?: string; status?: RecStatus },
): Promise<RecommendationRow[]> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, platform, key, category, priority, title, rationale, suggested_action, source, evidence, status, created_at, pr_url
       FROM instinct_automation_recommendations
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR platform = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               created_at DESC`,
    [workspaceId, opts?.platform ?? null, opts?.status ?? null],
  );
  return rows.map(toRow);
}

/** Fetch one recommendation by id (for the remediation flow). */
export async function getRecommendationById(workspaceId: string, id: string): Promise<RecommendationRow | null> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, platform, key, category, priority, title, rationale, suggested_action, source, evidence, status, created_at, pr_url
       FROM instinct_automation_recommendations
      WHERE workspace_id = $1 AND id = $2
      LIMIT 1`,
    [workspaceId, id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Record the remediation PR opened for a recommendation; marks it accepted. */
export async function setRecommendationPr(
  workspaceId: string,
  id: string,
  prUrl: string,
  decidedBy: string,
): Promise<RecommendationRow | null> {
  const { rows } = await writeQuery<DbRow>(
    `UPDATE instinct_automation_recommendations
        SET pr_url = $3, pr_opened_at = NOW(), status = 'accepted', decided_by = $4, decided_at = NOW()
      WHERE workspace_id = $1 AND id = $2
      RETURNING id, platform, key, category, priority, title, rationale, suggested_action, source, evidence, status, created_at, pr_url`,
    [workspaceId, id, prUrl, decidedBy],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function triageRecommendation(
  workspaceId: string,
  id: string,
  status: RecStatus,
  decidedBy: string,
): Promise<RecommendationRow | null> {
  const { rows } = await writeQuery<DbRow>(
    `UPDATE instinct_automation_recommendations
        SET status = $3, decided_by = $4, decided_at = NOW()
      WHERE workspace_id = $1 AND id = $2
      RETURNING id, platform, key, category, priority, title, rationale, suggested_action, source, evidence, status, created_at`,
    [workspaceId, id, status, decidedBy],
  );
  return rows[0] ? toRow(rows[0]) : null;
}
