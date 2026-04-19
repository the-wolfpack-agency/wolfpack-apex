/**
 * brief-generations — CRUD helpers for apex_site_brief_generations.
 *
 * Every image/PDF → SiteBrief round-trip lands here. The table exists
 * primarily for the learning loop: Qdrant + Neo4j get the event via
 * trackEvent(), but the canonical, queryable record of what was
 * uploaded, what palette we extracted, which model answered, how long
 * it took, and whether the brief was ultimately accepted — lives here.
 *
 * NO orphans: every call to briefFromImage() inserts a row. A row
 * flipping from accepted=NULL → true/false is the signal the brain
 * uses to measure wireframe-prompt quality over time.
 */

import { safeQuery } from "@/lib/db";
import type { SiteBrief } from "@/lib/sites-schema";

export interface BriefGenerationRow {
  id: string;
  project_id: string | null;
  requested_by: string;
  source_mime: string;
  source_size: number;
  source_sha256: string;
  extracted_brief: SiteBrief;
  extracted_colors: string[] | null;
  detected_font: string | null;
  model: string;
  latency_ms: number;
  token_cost_cents: number | null;
  accepted: boolean | null;
  created_at: string;
}

export interface InsertBriefGenerationInput {
  id: string;
  requestedBy: string;
  sourceMime: string;
  sourceSize: number;
  sourceSha256: string;
  extractedBrief: SiteBrief;
  extractedColors?: string[] | null;
  detectedFont?: string | null;
  model: string;
  latencyMs: number;
  tokenCostCents?: number | null;
}

/**
 * Insert a generation row with accepted=NULL. The caller (API route)
 * already holds `id` so it can return it to the UI and the UI can flip
 * the row on user commit/discard.
 */
export async function insertBriefGeneration(
  input: InsertBriefGenerationInput,
): Promise<void> {
  await safeQuery(
    `INSERT INTO apex_site_brief_generations
       (id, project_id, requested_by, source_mime, source_size, source_sha256,
        extracted_brief, extracted_colors, detected_font, model,
        latency_ms, token_cost_cents, accepted)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)`,
    [
      input.id,
      input.requestedBy,
      input.sourceMime,
      input.sourceSize,
      input.sourceSha256,
      JSON.stringify(input.extractedBrief),
      input.extractedColors ?? null,
      input.detectedFont ?? null,
      input.model,
      input.latencyMs,
      input.tokenCostCents ?? null,
    ],
  );
}

/**
 * Flip the `accepted` flag + optionally link the generation to a
 * newly-created SiteProject. Returns the row's project_id (or null if
 * the row didn't exist — silent, not an error, matching safeQuery's
 * shadow-mode contract).
 */
export async function recordBriefGenerationDecision(
  generationId: string,
  accepted: boolean,
  projectId: string | null = null,
): Promise<{ projectId: string | null }> {
  const result = await safeQuery<{ project_id: string | null }>(
    `UPDATE apex_site_brief_generations
        SET accepted = $2,
            project_id = COALESCE($3, project_id)
      WHERE id = $1
      RETURNING project_id`,
    [generationId, accepted, projectId],
  );
  return { projectId: result.rows[0]?.project_id ?? null };
}

/**
 * Fetch recent generations for a user — powers the "Drafts" UI sidebar
 * and the learning-loop dashboard. Newest first.
 */
export async function listBriefGenerationsForUser(
  userId: string,
  limit = 20,
): Promise<BriefGenerationRow[]> {
  const result = await safeQuery<BriefGenerationRow>(
    `SELECT id, project_id, requested_by, source_mime, source_size,
            source_sha256, extracted_brief, extracted_colors,
            detected_font, model, latency_ms, token_cost_cents,
            accepted, created_at
       FROM apex_site_brief_generations
      WHERE requested_by = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

/**
 * De-dupe lookup: did we already process this exact image recently?
 * Uploading the same PNG twice shouldn't cost two Claude calls.
 */
export async function findRecentGenerationBySha(
  sha256: string,
  sinceHours = 24,
): Promise<BriefGenerationRow | null> {
  const result = await safeQuery<BriefGenerationRow>(
    `SELECT id, project_id, requested_by, source_mime, source_size,
            source_sha256, extracted_brief, extracted_colors,
            detected_font, model, latency_ms, token_cost_cents,
            accepted, created_at
       FROM apex_site_brief_generations
      WHERE source_sha256 = $1
        AND created_at > NOW() - INTERVAL '1 hour' * $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [sha256, sinceHours],
  );
  return result.rows[0] ?? null;
}
