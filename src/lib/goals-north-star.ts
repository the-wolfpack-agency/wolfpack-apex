/**
 * Company Goals v1 — North Star snapshot lib.
 *
 * STUB (to be replaced by Stream U3). Provides captureNorthStar() +
 * getNorthStarTrend() so the dashboard tile + /goals page can render a
 * value + sparkline. U3 will add triple-write fan-out and rollup
 * helpers.
 */

import { safeQuery, writeQuery } from "@/lib/db";

export interface NorthStarSnapshot {
  id: string;
  value: number;
  unit: string | null;
  label: string;
  captured_at: string;
}

export interface CaptureNorthStarInput {
  value: number;
  label: string;
  unit?: string | null;
}

function mapRow(row: Record<string, unknown>): NorthStarSnapshot {
  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString() : v == null ? null : String(v);
  return {
    id: String(row.id),
    value: Number(row.value),
    unit: row.unit == null ? null : String(row.unit),
    label: String(row.label),
    captured_at: iso(row.captured_at) ?? new Date().toISOString(),
  };
}

/**
 * Delete a single North Star snapshot by id. Admin-gated at the route
 * level. Returns the deleted snapshot or null if missing.
 */
export async function deleteNorthStar(id: string): Promise<NorthStarSnapshot | null> {
  const res = await writeQuery<Record<string, unknown>>(
    `DELETE FROM instinct_north_star_snapshots WHERE id = $1
     RETURNING id, value, unit, label, captured_at`,
    [id],
  );
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0]);
}

/**
 * Update the value / label / unit on an existing snapshot. Convenience
 * for fixing a mis-entered number without appending a new row.
 */
export interface UpdateNorthStarInput {
  value?: number;
  label?: string;
  unit?: string | null;
}
export async function updateNorthStar(
  id: string,
  input: UpdateNorthStarInput,
): Promise<NorthStarSnapshot | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (typeof input.value === "number" && Number.isFinite(input.value)) {
    params.push(input.value);
    sets.push(`value = $${params.length}`);
  }
  if (typeof input.label === "string" && input.label.trim().length > 0) {
    params.push(input.label.trim());
    sets.push(`label = $${params.length}`);
  }
  if (input.unit !== undefined) {
    params.push(input.unit);
    sets.push(`unit = $${params.length}`);
  }
  if (sets.length === 0) {
    const res = await safeQuery<Record<string, unknown>>(
      `SELECT id, value, unit, label, captured_at FROM instinct_north_star_snapshots WHERE id = $1`,
      [id],
    );
    return res.rows.length === 0 ? null : mapRow(res.rows[0]);
  }
  const res = await writeQuery<Record<string, unknown>>(
    `UPDATE instinct_north_star_snapshots SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id, value, unit, label, captured_at`,
    params,
  );
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0]);
}

export async function captureNorthStar(
  input: CaptureNorthStarInput,
): Promise<NorthStarSnapshot> {
  const res = await safeQuery<Record<string, unknown>>(
    `INSERT INTO instinct_north_star_snapshots (value, unit, label)
     VALUES ($1, $2, $3)
     RETURNING id, value, unit, label, captured_at`,
    [input.value, input.unit ?? null, input.label],
  );
  if (res.rows.length === 0) {
    throw new Error("goals-north-star.captureNorthStar: insert failed");
  }
  return mapRow(res.rows[0]);
}

export async function getNorthStarTrend(opts: {
  label?: string;
  limit?: number;
} = {}): Promise<{ latest: NorthStarSnapshot | null; history: NorthStarSnapshot[] }> {
  const limit = Math.max(1, Math.min(Number(opts.limit ?? 14), 365));
  const res = opts.label
    ? await safeQuery<Record<string, unknown>>(
        `SELECT id, value, unit, label, captured_at
           FROM instinct_north_star_snapshots
          WHERE label = $1
          ORDER BY captured_at DESC
          LIMIT $2`,
        [opts.label, limit],
      )
    : await safeQuery<Record<string, unknown>>(
        `SELECT id, value, unit, label, captured_at
           FROM instinct_north_star_snapshots
          ORDER BY captured_at DESC
          LIMIT $1`,
        [limit],
      );
  const history = res.rows.map(mapRow);
  return {
    latest: history.length > 0 ? history[0] : null,
    // Oldest-first so the sparkline renders left-to-right chronologically.
    history: history.slice().reverse(),
  };
}
