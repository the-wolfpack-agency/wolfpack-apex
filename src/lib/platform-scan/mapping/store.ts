/**
 * Persistence for a walked SystemMap.
 *
 * WHY IT IS NOT THE PROFILE TABLE. instinct_system_profiles holds what static
 * introspection of a repository found: file counts, migration names, package
 * dependencies. That model is right when the system is ours. It is unavailable
 * when the system is a third-party product the client runs, which is most of
 * what a client actually depends on and precisely why the walker exists.
 *
 * Coercing a walk into a profile row means writing zero into the migrations
 * and tests columns, which says "this system has no tests" when the truth is
 * "we looked at it from outside and could not tell". That collapse between
 * absence and zero is the defect class this product has spent its life
 * learning to keep apart, and it would have gone straight into the report a
 * client reads.
 *
 * Follows the profile store exactly in everything that is genuinely shared:
 * upsert per target, scalars denormalised for listing, and safeQuery so a
 * transient store problem never fails the walk that produced the map.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import type { SystemMap } from "./types";

export interface WalkedMapRow {
  platform: string;
  entryUrl: string;
  map: SystemMap;
  surfaceCount: number;
  entityCount: number;
  formCount: number;
  /** Non-zero means the map is INCOMPLETE and every claim inherits that. */
  frontierRemaining: number;
  stopReason: string | null;
  authorisedBy: string;
  generatedAt: string;
}

interface DbRow {
  platform: string;
  entry_url: string;
  map: SystemMap | string;
  surface_count: number;
  entity_count: number;
  form_count: number;
  frontier_remaining: number;
  stop_reason: string | null;
  authorised_by: string;
  generated_at: string | Date;
}

function toRow(r: DbRow): WalkedMapRow {
  return {
    platform: String(r.platform),
    entryUrl: String(r.entry_url),
    map: typeof r.map === "string" ? (JSON.parse(r.map) as SystemMap) : r.map,
    surfaceCount: Number(r.surface_count) || 0,
    entityCount: Number(r.entity_count) || 0,
    formCount: Number(r.form_count) || 0,
    frontierRemaining: Number(r.frontier_remaining) || 0,
    stopReason: r.stop_reason ?? null,
    authorisedBy: String(r.authorised_by),
    generatedAt:
      r.generated_at instanceof Date ? r.generated_at.toISOString() : String(r.generated_at),
  };
}

/**
 * Store a walk.
 *
 * authorisedBy is required and not defaulted. It is the record that walking
 * somebody else's system was permitted, which outlives the map itself, and a
 * default value would quietly make every scan look authorised.
 */
export async function saveWalkedMap(
  workspaceId: string,
  map: SystemMap,
  authorisedBy: string,
): Promise<void> {
  if (!authorisedBy.trim()) {
    throw new Error("saveWalkedMap needs who authorised the walk");
  }
  /* Counted here rather than trusted from a caller, so the listing figures and
     the document can never disagree. */
  const formCount = new Set(map.surfaces.flatMap((s) => s.forms.map((f) => f.name))).size;

  await writeQuery(
    `INSERT INTO instinct_walked_system_maps
       (workspace_id, platform, entry_url, map, surface_count, entity_count, form_count,
        frontier_remaining, stop_reason, authorised_by, generated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (workspace_id, entry_url) DO UPDATE SET
       platform = EXCLUDED.platform,
       map = EXCLUDED.map,
       surface_count = EXCLUDED.surface_count,
       entity_count = EXCLUDED.entity_count,
       form_count = EXCLUDED.form_count,
       frontier_remaining = EXCLUDED.frontier_remaining,
       stop_reason = EXCLUDED.stop_reason,
       authorised_by = EXCLUDED.authorised_by,
       generated_at = NOW()`,
    [
      workspaceId,
      map.platform,
      map.entryUrl,
      JSON.stringify(map),
      map.surfaces.length,
      map.entities.length,
      formCount,
      map.coverage.frontierRemaining,
      map.coverage.stopReason,
      authorisedBy.trim(),
    ],
  );
}

/*
 * THE SELECT LIST IS REPEATED ON PURPOSE, which is worth a sentence because it
 * looks like the kind of duplication that should be factored out.
 *
 * It was factored out, into a shared constant, and the tenant-isolation scan
 * immediately flagged both queries as unclassified cross-tenant reads. The
 * scan reads the SQL literal at the call site; a template that assembles the
 * filter elsewhere is invisible to it, so a query that WAS workspace-scoped
 * could not be verified as workspace-scoped.
 *
 * That is not a false positive worth silencing. The next person adding a third
 * read from the same constant can forget the WHERE clause, and nothing would
 * catch it. Six duplicated column names are cheaper than a filter no tool can
 * see.
 */
export async function listWalkedMaps(workspaceId: string): Promise<WalkedMapRow[]> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT platform, entry_url, map, surface_count, entity_count, form_count,
            frontier_remaining, stop_reason, authorised_by, generated_at
       FROM instinct_walked_system_maps
      WHERE workspace_id = $1
      ORDER BY generated_at DESC`,
    [workspaceId],
  );
  return rows.map(toRow);
}

export async function getWalkedMap(
  workspaceId: string,
  entryUrl: string,
): Promise<WalkedMapRow | null> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT platform, entry_url, map, surface_count, entity_count, form_count,
            frontier_remaining, stop_reason, authorised_by, generated_at
       FROM instinct_walked_system_maps
      WHERE workspace_id = $1 AND entry_url = $2
      LIMIT 1`,
    [workspaceId, entryUrl],
  );
  return rows[0] ? toRow(rows[0]) : null;
}
