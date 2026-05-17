/**
 * Integration template registry — read/write surface for the
 * integration_templates table (migration 141).
 *
 * One row per widget / form / surface that mirrors an external tool.
 * The registry is what the admin dashboard queries to answer "what
 * does each surface map to" and what the nightly orchestrator
 * updates when a schema drifts.
 */

import { safeQuery } from "@/lib/db";

export type TemplateSurface = "widget" | "form" | "page_facts";

export interface IntegrationTemplate {
  id: string;
  templateId: string;
  surface: TemplateSurface;
  vendor: string;
  objectType: string | null;
  useCases: string[];
  lastKnownSchemaHash: string | null;
  fallbackFieldSet: Array<{ name: string; required?: boolean; type?: string }>;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  template_id: string;
  surface: string;
  vendor: string;
  object_type: string | null;
  use_cases: string;
  last_known_schema_hash: string | null;
  fallback_field_set: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToTemplate(row: Row): IntegrationTemplate {
  return {
    id: row.id,
    templateId: row.template_id,
    surface: row.surface as TemplateSurface,
    vendor: row.vendor,
    objectType: row.object_type,
    useCases: parseJsonArray(row.use_cases).map(String),
    lastKnownSchemaHash: row.last_known_schema_hash,
    fallbackFieldSet: parseJsonArray(row.fallback_field_set) as IntegrationTemplate["fallbackFieldSet"],
    notes: row.notes,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListTemplatesQuery {
  vendor?: string;
  surface?: TemplateSurface;
  /** Default true. Set false to include retired templates. */
  activeOnly?: boolean;
}

export async function listIntegrationTemplates(
  query: ListTemplatesQuery = {},
): Promise<IntegrationTemplate[]> {
  if (!process.env.DATABASE_URL) return [];
  const conds: string[] = [];
  const params: unknown[] = [];
  if (query.vendor) {
    params.push(query.vendor);
    conds.push(`vendor = $${params.length}`);
  }
  if (query.surface) {
    params.push(query.surface);
    conds.push(`surface = $${params.length}`);
  }
  if (query.activeOnly !== false) {
    conds.push(`is_active = TRUE`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  try {
    const r = await safeQuery<Row>(
      `SELECT id, template_id, surface, vendor, object_type, use_cases,
              last_known_schema_hash, fallback_field_set, notes, is_active,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM integration_templates
         ${where}
         ORDER BY vendor, surface, template_id`,
      params,
    );
    return r.rows.map(rowToTemplate);
  } catch (err) {
    console.warn("[templates/registry] list failed:", (err as Error).message);
    return [];
  }
}

export async function getIntegrationTemplate(
  templateId: string,
): Promise<IntegrationTemplate | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await safeQuery<Row>(
      `SELECT id, template_id, surface, vendor, object_type, use_cases,
              last_known_schema_hash, fallback_field_set, notes, is_active,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM integration_templates
        WHERE template_id = $1
        LIMIT 1`,
      [templateId],
    );
    return r.rows[0] ? rowToTemplate(r.rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Update the last-known schema hash for a template. Called by the
 * nightly orchestrator when a probe produces a fresh hash.
 */
export async function updateTemplateSchemaHash(
  templateId: string,
  schemaHash: string,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const r = await safeQuery<{ template_id: string }>(
      `UPDATE integration_templates
          SET last_known_schema_hash = $2,
              updated_at = NOW()
        WHERE template_id = $1
        RETURNING template_id`,
      [templateId, schemaHash],
    );
    return r.rows.length > 0;
  } catch (err) {
    console.warn("[templates/registry] update hash failed:", (err as Error).message);
    return false;
  }
}
