/**
 * AI-code governance ledger store (instinct_ai_code_reviews, migration 212).
 *
 * Workspace-scoped. Persistence is best-effort (safeQuery): a missing DATABASE_URL
 * or a transient DB error must NOT swallow the gate's verdict, which is the
 * primary value - the review is always returned, the durable row is a bonus for
 * history + the learning loop. id is a deterministic hash over
 * (workspace, ref, author, createdAt) so a row is stable per review event.
 */
import { createHash } from "node:crypto";
import { safeQuery } from "@/lib/db";
import type { CodeReviewResult } from "./types";

export interface ReviewRecord {
  id: string;
  ref: string;
  author: string | null;
  outcome: string;
  highestSeverity: string | null;
  findingCount: number;
  createdAt: string;
}

interface DbRow {
  id: string;
  ref: string;
  author: string | null;
  outcome: string;
  highest_severity: string | null;
  finding_count: number;
  created_at: string;
}

/** Persist one review. Returns the row id (best-effort; the caller already has
 *  the verdict regardless of whether the write lands). */
export async function recordReview(workspaceId: string, result: CodeReviewResult, nowIso: string): Promise<string> {
  const id = `acr_${createHash("sha256")
    .update([workspaceId, result.ref, result.author, nowIso].join(" "))
    .digest("hex")
    .slice(0, 24)}`;
  await safeQuery(
    `INSERT INTO instinct_ai_code_reviews
       (id, workspace_id, ref, author, outcome, highest_severity, finding_count, findings, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      workspaceId,
      result.ref,
      result.author,
      result.verdict.outcome,
      result.verdict.highestSeverity,
      result.findings.length,
      JSON.stringify(result.findings),
      nowIso,
    ],
  );
  return id;
}

/** Review history for a workspace, newest first. Workspace-scoped + parameterized. */
export async function listReviews(workspaceId: string, limit = 100): Promise<ReviewRecord[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const res = await safeQuery<DbRow>(
    `SELECT id, ref, author, outcome, highest_severity, finding_count,
            created_at::text AS created_at
       FROM instinct_ai_code_reviews
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT ${lim}`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    author: r.author,
    outcome: r.outcome,
    highestSeverity: r.highest_severity,
    findingCount: r.finding_count,
    createdAt: r.created_at,
  }));
}
