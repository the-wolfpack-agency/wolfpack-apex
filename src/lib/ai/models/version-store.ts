/**
 * Persist which weights served, and report when that changed.
 *
 * Separated from version-drift.ts so the RULE stays pure and testable without a
 * database, and only this file knows about SQL. Every function here degrades
 * rather than throwing: a version record that fails to write must never cost a
 * user the answer they were waiting for.
 */
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { observeVersion, isMaterial, normalizeVersion, type KnownVersion, type DriftObservation } from "./version-drift";

/** Versions recorded for a model, most recently seen first. */
export async function knownVersions(modelId: string): Promise<KnownVersion[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { rows } = await query<{ served_version: string; last_seen_at: string; call_count: string }>(
      `SELECT served_version, last_seen_at::text, call_count::text
         FROM ai_model_versions
        WHERE model_id = $1
        ORDER BY last_seen_at DESC
        LIMIT 20`,
      [modelId],
    );
    return rows.map((r) => ({
      servedVersion: r.served_version,
      lastSeenAt: r.last_seen_at,
      callCount: Number(r.call_count) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Record that a version served, and report the drift.
 *
 * Reads the known versions BEFORE writing, so the comparison is against the
 * world as it was rather than against a row this call just created. Written
 * the other way round every call would report "unchanged" against itself.
 */
export async function recordServedVersion(input: {
  modelId: string;
  servedVersion: string;
  provider: string;
  workspaceId?: string;
  feature?: string;
}): Promise<DriftObservation | null> {
  const served = normalizeVersion(input.servedVersion);
  if (!served || !input.modelId) return null;

  const known = await knownVersions(input.modelId);
  const observation = observeVersion({ modelId: input.modelId, servedVersion: served, known });

  if (process.env.DATABASE_URL) {
    try {
      await query(
        `INSERT INTO ai_model_versions (model_id, served_version, provider)
         VALUES ($1, $2, $3)
         ON CONFLICT (model_id, served_version) DO UPDATE SET
           last_seen_at = NOW(),
           call_count   = ai_model_versions.call_count + 1`,
        [input.modelId, served, input.provider],
      );
    } catch {
      /* An answer already produced is worth more than a bookkeeping row. */
    }
  }

  /* Only the material ones are events. A new version is not a problem, it is
     the thing that makes a later regression explainable, and reporting every
     call would train everybody to ignore the signal. */
  if (isMaterial(observation)) {
    trackEvent("ai.model_version_changed", "system", "system", {
      model_id: observation.modelId,
      served_version: observation.servedVersion,
      previous_version: observation.previousVersion ?? "",
      previous_call_count: observation.previousCallCount ?? 0,
      kind: observation.kind,
      provider: input.provider,
      workspace_id: input.workspaceId ?? "default",
      feature: input.feature ?? "unknown",
    });
  }

  return observation;
}

/** Every model's version history, for the admin surface. */
export interface ModelVersionRow {
  modelId: string;
  servedVersion: string;
  provider: string;
  firstSeenAt: string;
  lastSeenAt: string;
  callCount: number;
  /** True for the version currently serving this model id. */
  current: boolean;
}

export async function allModelVersions(): Promise<ModelVersionRow[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { rows } = await query<{
      model_id: string;
      served_version: string;
      provider: string;
      first_seen_at: string;
      last_seen_at: string;
      call_count: string;
      is_current: boolean;
    }>(
      `SELECT model_id, served_version, provider,
              first_seen_at::text, last_seen_at::text, call_count::text,
              last_seen_at = MAX(last_seen_at) OVER (PARTITION BY model_id) AS is_current
         FROM ai_model_versions
        ORDER BY model_id ASC, last_seen_at DESC`,
    );
    return rows.map((r) => ({
      modelId: r.model_id,
      servedVersion: r.served_version,
      provider: r.provider,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      callCount: Number(r.call_count) || 0,
      current: r.is_current,
    }));
  } catch {
    return [];
  }
}
