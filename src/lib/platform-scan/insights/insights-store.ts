/**
 * Cross-scan insight persistence - the durable side of the cross-scan engine.
 *
 * correlate.ts is PURE (computes Insight[], no I/O); generate.ts wires it to the
 * finding corpus + analytics. This store closes the persistence gap: every
 * generated insight becomes a durable row in instinct_cross_scan_insights (one row
 * per logical insight, keyed by the stable dedup `key` so re-runs UPSERT rather
 * than pile up), and listRecentInsights reads them back for the dashboard.
 *
 * No data lost: every insight the engine ever produced is durable here,
 * complementing the analytics events generate.ts fires. Mirrors the platform-scan
 * + benchmark store idiom: writeQuery for the write, safeQuery for the read so a
 * missing DB degrades to [] / a no-op instead of throwing.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import type { Insight, InsightKind, FindingRef } from "./correlate";
import type { ScanSeverity, ScanCategory } from "../types";

/** A persisted insight, shaped for the dashboard feed. */
export interface InsightRow {
  id: string;
  generatedAt: string;
  platform: string;
  kind: InsightKind;
  severity: ScanSeverity;
  modalities: ScanCategory[];
  members: FindingRef[];
  narrative: string;
  status: string;
  key: string;
}

type DbRow = Record<string, unknown>;

function toInsightRow(r: DbRow): InsightRow {
  return {
    id: String(r.id),
    generatedAt:
      r.generated_at instanceof Date ? r.generated_at.toISOString() : String(r.generated_at),
    platform: String(r.platform ?? ""),
    kind: String(r.kind) as InsightKind,
    severity: String(r.severity) as ScanSeverity,
    modalities: (r.modalities ?? []) as ScanCategory[],
    members: (r.members ?? []) as FindingRef[],
    narrative: String(r.narrative ?? ""),
    status: String(r.status ?? "open"),
    key: String(r.key),
  };
}

/**
 * Persist a batch of insights for a workspace, UPSERTING by the TENANT-SCOPED key
 * (workspace_id, key) so re-running the engine never duplicates an insight (it
 * refreshes severity/members/narrative + the generated_at timestamp instead).
 * Returns how many rows were written.
 *
 * Cross-tenant isolation (FIX 2): the dedup key is `kind::platform::route::...`
 * with NO tenant in it, so two workspaces that scan the same platform/route
 * produce the SAME key. The old `ON CONFLICT (key)` therefore let workspace B
 * OVERWRITE workspace A's row, and the unfiltered read served it back to the
 * wrong tenant. Scoping the conflict target to (workspace_id, key) - backed by the
 * UNIQUE(workspace_id, key) index in migration 206 - and namespacing the id by
 * workspace keeps each tenant's insights its own.
 *
 * Degrades gracefully: a DB error (or shadow mode) is caught per-row and the
 * function returns the count it managed, never throwing - a transient store hiccup
 * must not lose the insights the engine already emitted to analytics.
 */
export async function recordInsights(
  insights: Insight[],
  workspaceId: string,
): Promise<{ written: number }> {
  let written = 0;
  for (const ins of insights) {
    // Deterministic id derived from workspace + key keeps the id stable across
    // re-runs AND unique per tenant; ON CONFLICT (workspace_id, key) is the dedup
    // guard. Two tenants sharing a key get two distinct rows + ids.
    const id = `xins_${workspaceId}_${ins.key}`;
    try {
      await writeQuery(
        `INSERT INTO instinct_cross_scan_insights
           (id, workspace_id, platform, kind, severity, modalities, members, narrative, key)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
         ON CONFLICT (workspace_id, key) DO UPDATE SET
           severity   = EXCLUDED.severity,
           modalities = EXCLUDED.modalities,
           members    = EXCLUDED.members,
           narrative  = EXCLUDED.narrative,
           generated_at = NOW()`,
        [
          id,
          workspaceId,
          ins.platform,
          ins.kind,
          ins.severity,
          JSON.stringify(ins.modalities),
          JSON.stringify(ins.members),
          ins.narrative,
          ins.key,
        ],
      );
      written += 1;
    } catch (err) {
      // Best effort per row: one bad row never loses the rest, and the analytics
      // events already fired in generate.ts carry the data into the learning loop.
      console.warn("[insights-store] recordInsights row failed:", (err as Error).message);
    }
  }
  return { written };
}

/**
 * Recent insights for a workspace, newest first, for the dashboard feed. Default
 * limit 50, capped at 200. Degrades to [] with no DB (safeQuery) so the dashboard
 * renders its explicit empty state rather than 500ing.
 *
 * Tenant isolation (FIX 2): EVERY read is filtered by workspace_id. The old read
 * had no filter, so it served one tenant's insights to another. A row with a NULL
 * workspace_id (pre-206 backfill is additive, so legacy rows may have NULL) is
 * deliberately NOT returned to any tenant - it cannot be attributed safely.
 */
export async function listRecentInsights(
  workspaceId: string,
  limit?: number,
): Promise<InsightRow[]> {
  const lim = Math.min(Math.max(limit ?? 50, 1), 200);
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, generated_at, platform, kind, severity, modalities, members,
            narrative, status, key
       FROM instinct_cross_scan_insights
      WHERE workspace_id = $1
      ORDER BY generated_at DESC
      LIMIT $2`,
    [workspaceId, lim],
  );
  return rows.map(toInsightRow);
}
