/**
 * Persistence for SystemProfile. Upserts one row per (workspace, platform) so
 * re-profiling replaces the prior snapshot; scalar columns are denormalized for
 * fast listing. Degrades safely with no DB (safeQuery), so a profile build never
 * hard-fails on a transient store issue.
 */
import { safeQuery, writeQuery } from "@/lib/db";
import type { SystemProfile } from "./types";

export interface SystemProfileRow {
  platform: string;
  profile: SystemProfile;
  entityCount: number;
  integrationCount: number;
  routeCount: number;
  criticalCount: number;
  generatedAt: string;
}

export async function saveSystemProfile(workspaceId: string, profile: SystemProfile): Promise<void> {
  const routeCount = profile.authModel.publicRoutes + profile.authModel.protectedRoutes;
  await writeQuery(
    `INSERT INTO instinct_system_profiles
       (workspace_id, platform, profile, entity_count, integration_count, route_count, critical_count, generated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NOW())
     ON CONFLICT (workspace_id, platform) DO UPDATE SET
       profile = EXCLUDED.profile,
       entity_count = EXCLUDED.entity_count,
       integration_count = EXCLUDED.integration_count,
       route_count = EXCLUDED.route_count,
       critical_count = EXCLUDED.critical_count,
       generated_at = NOW()`,
    [
      workspaceId,
      profile.platform,
      JSON.stringify(profile),
      profile.entities.length,
      profile.integrations.length,
      routeCount,
      profile.riskSummary.critical,
    ],
  );
}

interface DbRow {
  platform: string;
  profile: SystemProfile | string;
  entity_count: number;
  integration_count: number;
  route_count: number;
  critical_count: number;
  generated_at: string | Date;
}

function toRow(r: DbRow): SystemProfileRow {
  return {
    platform: String(r.platform),
    profile: typeof r.profile === "string" ? (JSON.parse(r.profile) as SystemProfile) : r.profile,
    entityCount: Number(r.entity_count) || 0,
    integrationCount: Number(r.integration_count) || 0,
    routeCount: Number(r.route_count) || 0,
    criticalCount: Number(r.critical_count) || 0,
    generatedAt: r.generated_at instanceof Date ? r.generated_at.toISOString() : String(r.generated_at),
  };
}

export async function getSystemProfile(workspaceId: string, platform: string): Promise<SystemProfileRow | null> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT platform, profile, entity_count, integration_count, route_count, critical_count, generated_at
       FROM instinct_system_profiles
      WHERE workspace_id = $1 AND platform = $2
      LIMIT 1`,
    [workspaceId, platform],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listSystemProfiles(workspaceId: string): Promise<SystemProfileRow[]> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT platform, profile, entity_count, integration_count, route_count, critical_count, generated_at
       FROM instinct_system_profiles
      WHERE workspace_id = $1
      ORDER BY generated_at DESC`,
    [workspaceId],
  );
  return rows.map(toRow);
}
