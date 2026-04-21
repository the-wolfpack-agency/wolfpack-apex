/**
 * Instinct L3 — polymorphic entity tags.
 *
 * Any entity in the system (MS event, site project, document, conversation,
 * contact, file, …) can have arbitrary `(tag_key, tag_value)` labels attached
 * to it WITHOUT modifying the entity's canonical table. L1 canonical tables
 * stay pristine — feature code writes L3 tags/links, never L1 rows.
 *
 * Deletion policy: HARD delete by id (see removeTag). Tag history is already
 * preserved in two other places — analytics (`entity.tag_applied` /
 * `entity.tag_removed` events with timestamps) and the audit log — so a
 * soft-delete column here would just be duplicated state. If a caller needs
 * "when was this tag last on this entity" they query the analytics events.
 *
 * Every mutation fires trackEvent() to feed the learning loop.
 */

import { randomUUID } from "node:crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface EntityTag {
  id: string;
  entity_type: string;
  entity_id: string;
  tag_key: string;
  tag_value: string;
  auto_applied: boolean;
  applied_by_user_id: string | null;
  created_at: string;
}

export interface ApplyTagOptions {
  /** Whether this tag was produced by an automated rule (default: false). */
  auto?: boolean;
  /** User id for human-applied tags. Ignored when auto === true. */
  userId?: string | null;
  /** User role for analytics tracking (default: "system" for auto). */
  userRole?: string;
}

/**
 * Attach a tag to an entity. Idempotent on
 * `(entity_type, entity_id, tag_key, tag_value, auto_applied)` — if a row
 * already exists with that combination, the existing row is returned and
 * no new row is written.
 *
 * Returns the persisted tag (either newly-inserted or pre-existing).
 */
export async function applyTag(
  entity_type: string,
  entity_id: string,
  tag_key: string,
  tag_value: string,
  opts: ApplyTagOptions = {},
): Promise<EntityTag> {
  const auto = opts.auto === true;
  const userId = auto ? null : opts.userId ?? null;
  const userRole = opts.userRole ?? (auto ? "system" : "user");

  const id = randomUUID();
  // INSERT ... ON CONFLICT DO NOTHING against the composite unique index
  // so re-running an auto-tag rule is safe. We still need the existing row
  // when we skipped, so we fall through to a SELECT on conflict.
  const inserted = await writeQuery<EntityTag>(
    `INSERT INTO instinct_entity_tags
       (id, entity_type, entity_id, tag_key, tag_value, auto_applied, applied_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entity_type, entity_id, tag_key, tag_value, auto_applied)
       DO NOTHING
     RETURNING *`,
    [id, entity_type, entity_id, tag_key, tag_value, auto, userId],
  );

  if (inserted.rows.length > 0) {
    trackEvent(
      "entity.tag_applied",
      userId ?? "system",
      userRole,
      { entity_type, tag_key, auto },
    );
    return inserted.rows[0];
  }

  // Already existed — fetch & return without emitting a duplicate event.
  const existing = await safeQuery<EntityTag>(
    `SELECT * FROM instinct_entity_tags
      WHERE entity_type = $1 AND entity_id = $2
        AND tag_key = $3 AND tag_value = $4 AND auto_applied = $5
      LIMIT 1`,
    [entity_type, entity_id, tag_key, tag_value, auto],
  );
  if (existing.rows.length === 0) {
    // Shouldn't happen: ON CONFLICT hit but SELECT returned nothing. This
    // can only occur in shadow mode (DATABASE_URL unset → safeQuery returns
    // empty). Writes already threw above in that case, so it's an invariant
    // violation if we get here with a real DB.
    throw new Error(
      "applyTag: ON CONFLICT hit but no existing row found — database state inconsistent.",
    );
  }
  return existing.rows[0];
}

export async function getTags(
  entity_type: string,
  entity_id: string,
): Promise<EntityTag[]> {
  const { rows } = await safeQuery<EntityTag>(
    `SELECT * FROM instinct_entity_tags
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY created_at ASC`,
    [entity_type, entity_id],
  );
  return rows;
}

export async function findByTag(
  tag_key: string,
  tag_value: string,
): Promise<Array<{ entity_type: string; entity_id: string }>> {
  const { rows } = await safeQuery<{ entity_type: string; entity_id: string }>(
    `SELECT DISTINCT entity_type, entity_id
       FROM instinct_entity_tags
      WHERE tag_key = $1 AND tag_value = $2
      ORDER BY entity_type, entity_id`,
    [tag_key, tag_value],
  );
  return rows;
}

/**
 * Hard-delete a tag by id. Fires an `entity.tag_removed` event so history is
 * still recoverable from analytics. Returns true if a row was deleted.
 */
export async function removeTag(
  id: string,
  opts: { userId?: string | null; userRole?: string } = {},
): Promise<boolean> {
  const { rows } = await writeQuery<EntityTag>(
    `DELETE FROM instinct_entity_tags WHERE id = $1 RETURNING *`,
    [id],
  );
  if (rows.length === 0) return false;
  const t = rows[0];
  trackEvent(
    "entity.tag_removed",
    opts.userId ?? t.applied_by_user_id ?? "system",
    opts.userRole ?? "user",
    { entity_type: t.entity_type, tag_key: t.tag_key, auto: t.auto_applied },
  );
  return true;
}
