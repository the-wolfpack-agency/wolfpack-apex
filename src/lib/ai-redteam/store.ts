/**
 * AI red-team ledger store (instinct_ai_redteam_runs, migration 213).
 *
 * Workspace-scoped. Persistence is best-effort (safeQuery) so a DB hiccup never
 * swallows the assurance result. id is a deterministic hash over (workspace,
 * created_at) so a run row is stable. The pure `riskFor` keeps the run risk and
 * the alerting threshold in one place.
 */
import { createHash } from "node:crypto";
import { safeQuery } from "@/lib/db";
import type { RedTeamReport } from "./types";

export interface RedTeamRunRecord {
  id: string;
  attacksRun: number;
  blocked: number;
  vulns: number;
  passRate: number;
  risk: string;
  source: string;
  createdAt: string;
}

interface DbRow {
  id: string;
  attacks_run: number;
  blocked: number;
  vulns: number;
  pass_rate: number;
  risk: string;
  source: string;
  created_at: string;
}

/** Any attack getting through is a gate regression: critical. Clean is low. */
export function riskFor(report: RedTeamReport): "low" | "critical" {
  return report.vulns.length > 0 ? "critical" : "low";
}

export async function recordRun(
  workspaceId: string,
  report: RedTeamReport,
  source: "cron" | "manual",
  nowIso: string,
): Promise<string> {
  const id = `art_${createHash("sha256").update([workspaceId, source, nowIso].join(" ")).digest("hex").slice(0, 24)}`;
  await safeQuery(
    `INSERT INTO instinct_ai_redteam_runs
       (id, workspace_id, attacks_run, blocked, vulns, pass_rate, findings, risk, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      workspaceId,
      report.attacksRun,
      report.blocked,
      report.vulns.length,
      report.passRate,
      JSON.stringify(report.vulns),
      riskFor(report),
      source,
      nowIso,
    ],
  );
  return id;
}

export async function listRuns(workspaceId: string, limit = 100): Promise<RedTeamRunRecord[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const res = await safeQuery<DbRow>(
    `SELECT id, attacks_run, blocked, vulns, pass_rate, risk, source,
            created_at::text AS created_at
       FROM instinct_ai_redteam_runs
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT ${lim}`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    attacksRun: r.attacks_run,
    blocked: r.blocked,
    vulns: r.vulns,
    passRate: Number(r.pass_rate),
    risk: r.risk,
    source: r.source,
    createdAt: r.created_at,
  }));
}
