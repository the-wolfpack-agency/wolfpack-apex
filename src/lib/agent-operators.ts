/**
 * Agent operators store + rollup - persist sightings and reconstruct the
 * operators board over time.
 *
 * A single probe run is a snapshot; persisting sightings turns it into an
 * operator HISTORY, which is the heart of attribution. Each sighting is stored
 * under its durable operator key (scaffolding + toolset fingerprint, non-PII);
 * the board groups a consistent operator across visits and surfaces and rebuilds
 * a fused dossier per operator. Reads fail open (empty) so the board degrades
 * rather than throwing.
 */
import { query, safeQuery } from "@/lib/db";
import { operatorKeyFor, buildDossiers, buildDossier, type Sighting, type AttributionDossier } from "@/lib/agent-dossier";
import type { AgentJourney } from "@/lib/agent-behavior";
import type { ScaffoldingSignature } from "@/lib/agent-probe";
import type { ToolCompositionReport } from "@/lib/agent-tool-composition";

/** Persist one sighting. Best effort: no DATABASE_URL -> skip; never throws so
 *  a storage hiccup cannot break the probe response. Returns the operator key. */
export async function recordSighting(input: { workspaceId: string; sighting: Sighting }): Promise<string | null> {
  const { workspaceId, sighting } = input;
  const operatorKey = operatorKeyFor(sighting.scaffolding, sighting.tools);
  if (!process.env.DATABASE_URL) return operatorKey;
  // Single-sighting threat, so the row carries a scannable level without a rebuild.
  const threat = buildDossier([sighting]).threatLevel;
  try {
    await query(
      `INSERT INTO instinct_agent_sightings
         (workspace_id, operator_key, surface, seen_at, behavior_class, behavior_confidence, threat_level, journey, scaffolding, tools)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        workspaceId, operatorKey, sighting.surface, sighting.at,
        sighting.journey.behaviorClass, sighting.journey.confidence, threat,
        JSON.stringify(sighting.journey), JSON.stringify(sighting.scaffolding), JSON.stringify(sighting.tools),
      ],
    );
  } catch (err) {
    console.warn("[agent-operators] recordSighting failed:", (err as Error).message);
  }
  return operatorKey;
}

interface SightingRow {
  surface: string;
  seen_at: string;
  journey: AgentJourney;
  scaffolding: ScaffoldingSignature;
  tools: ToolCompositionReport;
}

/** Clamp a day window into [1, 365]. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(days)));
}

/** Read stored sightings for a workspace over the window, newest first. */
export async function listSightings(workspaceId: string, rangeDays = 30, limit = 2000): Promise<Sighting[]> {
  const days = clampDays(rangeDays);
  const cap = Math.max(1, Math.min(limit, 5000));
  const { rows } = await safeQuery<SightingRow>(
    `SELECT surface, seen_at::text AS seen_at, journey, scaffolding, tools
       FROM instinct_agent_sightings
      WHERE workspace_id = $1
        AND seen_at > now() - ($2 || ' days')::interval
      ORDER BY seen_at DESC
      LIMIT ${cap}`,
    [workspaceId, String(days)],
  );
  return rows.map((r) => ({ surface: r.surface, at: r.seen_at, journey: r.journey, scaffolding: r.scaffolding, tools: r.tools }));
}

/** The operators board: stored sightings, grouped into per-operator dossiers,
 *  most-recent activity first (buildDossiers already sorts that way). */
export async function getOperators(workspaceId: string, rangeDays = 30): Promise<AttributionDossier[]> {
  const sightings = await listSightings(workspaceId, rangeDays);
  return buildDossiers(sightings);
}
