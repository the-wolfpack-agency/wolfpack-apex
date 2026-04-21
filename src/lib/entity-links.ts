/**
 * Instinct L3 — polymorphic entity links.
 *
 * A directed edge between two polymorphic entities. Same shape / same rules
 * as entity-tags.ts: feature code writes L3 rows, never L1 rows. Any edge
 * type can coexist (e.g. "attended", "discussed_in", "blocks", "replaces").
 *
 * Deletion policy: HARD delete, same rationale as entity-tags.
 * Dedup: `(from_type, from_id, to_type, to_id, link_type, auto_applied)`
 * unique index is the primary guarantee; applyLink reuses ON CONFLICT.
 */

import { randomUUID } from "node:crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface EntityLink {
  id: string;
  from_entity_type: string;
  from_entity_id: string;
  to_entity_type: string;
  to_entity_id: string;
  link_type: string;
  auto_applied: boolean;
  applied_by_user_id: string | null;
  created_at: string;
}

export interface EntityRef {
  entity_type: string;
  entity_id: string;
}

export interface LinkOptions {
  auto?: boolean;
  userId?: string | null;
  userRole?: string;
}

/**
 * Create a directed link from `from` to `to` with the given link_type.
 * Idempotent: re-running with the same tuple returns the existing row.
 */
export async function linkEntities(
  from: EntityRef,
  to: EntityRef,
  link_type: string,
  opts: LinkOptions = {},
): Promise<EntityLink> {
  const auto = opts.auto === true;
  const userId = auto ? null : opts.userId ?? null;
  const userRole = opts.userRole ?? (auto ? "system" : "user");

  const id = randomUUID();
  const inserted = await writeQuery<EntityLink>(
    `INSERT INTO instinct_entity_links
       (id, from_entity_type, from_entity_id,
        to_entity_type, to_entity_id,
        link_type, auto_applied, applied_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (from_entity_type, from_entity_id,
                  to_entity_type, to_entity_id,
                  link_type, auto_applied)
       DO NOTHING
     RETURNING *`,
    [
      id,
      from.entity_type,
      from.entity_id,
      to.entity_type,
      to.entity_id,
      link_type,
      auto,
      userId,
    ],
  );

  if (inserted.rows.length > 0) {
    trackEvent(
      "entity.link_created",
      userId ?? "system",
      userRole,
      {
        from_type: from.entity_type,
        to_type: to.entity_type,
        link_type,
        auto,
      },
    );
    return inserted.rows[0];
  }

  const existing = await safeQuery<EntityLink>(
    `SELECT * FROM instinct_entity_links
      WHERE from_entity_type = $1 AND from_entity_id = $2
        AND to_entity_type = $3 AND to_entity_id = $4
        AND link_type = $5 AND auto_applied = $6
      LIMIT 1`,
    [
      from.entity_type,
      from.entity_id,
      to.entity_type,
      to.entity_id,
      link_type,
      auto,
    ],
  );
  if (existing.rows.length === 0) {
    throw new Error(
      "linkEntities: ON CONFLICT hit but no existing row found — database state inconsistent.",
    );
  }
  return existing.rows[0];
}

export async function getLinksFrom(
  entity_type: string,
  entity_id: string,
  opts: { link_type?: string } = {},
): Promise<EntityLink[]> {
  const params: unknown[] = [entity_type, entity_id];
  let sql = `SELECT * FROM instinct_entity_links
              WHERE from_entity_type = $1 AND from_entity_id = $2`;
  if (opts.link_type) {
    params.push(opts.link_type);
    sql += ` AND link_type = $${params.length}`;
  }
  sql += ` ORDER BY created_at ASC`;
  const { rows } = await safeQuery<EntityLink>(sql, params);
  return rows;
}

export async function getLinksTo(
  entity_type: string,
  entity_id: string,
  opts: { link_type?: string } = {},
): Promise<EntityLink[]> {
  const params: unknown[] = [entity_type, entity_id];
  let sql = `SELECT * FROM instinct_entity_links
              WHERE to_entity_type = $1 AND to_entity_id = $2`;
  if (opts.link_type) {
    params.push(opts.link_type);
    sql += ` AND link_type = $${params.length}`;
  }
  sql += ` ORDER BY created_at ASC`;
  const { rows } = await safeQuery<EntityLink>(sql, params);
  return rows;
}

export async function unlinkEntities(
  id: string,
  opts: { userId?: string | null; userRole?: string } = {},
): Promise<boolean> {
  const { rows } = await writeQuery<EntityLink>(
    `DELETE FROM instinct_entity_links WHERE id = $1 RETURNING *`,
    [id],
  );
  if (rows.length === 0) return false;
  const l = rows[0];
  trackEvent(
    "entity.link_removed",
    opts.userId ?? l.applied_by_user_id ?? "system",
    opts.userRole ?? "user",
    {
      from_type: l.from_entity_type,
      to_type: l.to_entity_type,
      link_type: l.link_type,
      auto: l.auto_applied,
    },
  );
  return true;
}
