import { safeQuery } from "@/lib/db";

export interface FunnelRow {
  step: string;
  viewed_count: number;
  completed_count: number;
  abandoned_count: number;
  completion_rate: number;
  median_duration_ms: number | null;
}

export async function getSetupFunnel(): Promise<FunnelRow[]> {
  if (!process.env.DATABASE_URL) return [];

  const result = await safeQuery<FunnelRow>(
    `SELECT
       step,
       viewed_count,
       completed_count,
       abandoned_count,
       completion_rate,
       median_duration_ms
     FROM instinct_setup_funnel
     ORDER BY
       CASE step
         WHEN 'profile'      THEN 1
         WHEN 'team'         THEN 2
         WHEN 'integrations' THEN 3
         ELSE 4
       END`,
  );

  if (result.fromCache) return [];
  return result.rows;
}
