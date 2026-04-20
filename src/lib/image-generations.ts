/**
 * image-generations — CRUD helpers for instinct_site_image_generations.
 *
 * Every AI image-generation request (success OR failure) inserts a row.
 * Rows flip accepted=true when the user clicks "Use this image" in the
 * GenerateImageModal, or accepted=false when they dismiss the modal
 * without picking a result. NULL means still in-flight.
 *
 * Mirrors the brief-generations.ts pattern so the learning loop has a
 * uniform shape to aggregate against (prompt text, latency, model,
 * accepted/rejected) across both the wireframe-to-brief and
 * prompt-to-image surfaces.
 */

import { safeQuery } from "@/lib/db";

export type ImageAspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export interface ImageGenerationRow {
  id: string;
  project_id: string | null;
  requested_by: string;
  prompt: string;
  aspect_ratio: string;
  seed: number | null;
  model: string;
  image_url: string;
  repo_committed: boolean;
  cost_cents: number | null;
  latency_ms: number;
  accepted: boolean | null;
  created_at: string;
}

export interface InsertImageGenerationInput {
  id: string;
  projectId: string | null;
  requestedBy: string;
  prompt: string;
  aspectRatio: ImageAspectRatio | string;
  seed?: number | null;
  model: string;
  imageUrl: string;
  repoCommitted?: boolean;
  costCents?: number | null;
  latencyMs: number;
}

/**
 * Insert a generation row with accepted=NULL. Caller holds the id so the
 * UI can later flip the row on accept/dismiss via markImageGenerationAccepted().
 */
export async function insertImageGeneration(
  input: InsertImageGenerationInput,
): Promise<void> {
  await safeQuery(
    `INSERT INTO instinct_site_image_generations
       (id, project_id, requested_by, prompt, aspect_ratio, seed,
        model, image_url, repo_committed, cost_cents, latency_ms, accepted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)`,
    [
      input.id,
      input.projectId,
      input.requestedBy,
      input.prompt,
      input.aspectRatio,
      input.seed ?? null,
      input.model,
      input.imageUrl,
      input.repoCommitted ?? false,
      input.costCents ?? null,
      input.latencyMs,
    ],
  );
}

/**
 * Flip accepted — true when user picks "Use this image", false when they
 * cancel the modal. Returns the row's project_id for audit correlation
 * (or null if the row doesn't exist — silent, matching safeQuery's
 * shadow-mode contract).
 */
export async function markImageGenerationAccepted(
  generationId: string,
  accepted: boolean,
): Promise<{ projectId: string | null }> {
  const result = await safeQuery<{ project_id: string | null }>(
    `UPDATE instinct_site_image_generations
        SET accepted = $2
      WHERE id = $1
      RETURNING project_id`,
    [generationId, accepted],
  );
  return { projectId: result.rows[0]?.project_id ?? null };
}

/**
 * Count generations a user has performed in the last N hours. Used by the
 * route handler to enforce the 50/day cap BEFORE calling fal.ai so a
 * runaway UI can't burn through the budget.
 */
export async function countUserGenerationsSince(
  userId: string,
  sinceHours = 24,
): Promise<number> {
  const result = await safeQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM instinct_site_image_generations
      WHERE requested_by = $1
        AND created_at > NOW() - INTERVAL '1 hour' * $2`,
    [userId, sinceHours],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * Fetch recent generations for a user — powers a potential "Recent
 * images" side panel and the learning-loop dashboard. Newest first.
 */
export async function listImageGenerationsForUser(
  userId: string,
  limit = 20,
): Promise<ImageGenerationRow[]> {
  const result = await safeQuery<ImageGenerationRow>(
    `SELECT id, project_id, requested_by, prompt, aspect_ratio, seed,
            model, image_url, repo_committed, cost_cents, latency_ms,
            accepted, created_at
       FROM instinct_site_image_generations
      WHERE requested_by = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}
