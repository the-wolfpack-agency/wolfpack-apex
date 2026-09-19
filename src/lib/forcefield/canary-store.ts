/**
 * Forcefield canary registry - the decoys the tripwire matches against.
 *
 * Reuses the Canary shape from ./tripwire so the store and the detector cannot
 * drift. Two read paths, on purpose:
 *   - listCanariesForMatching (INTERNAL): the full decoy values, fed straight to
 *     inspectAgentAction. Never wired to a response body.
 *   - listCanariesForDisplay (SAFE): id / kind / where-seeded + a MASKED hint.
 *     Revealing the exact decoy values would let an attacker route around the
 *     deception, so the management surface never sees them.
 */
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { Canary, CanaryKind } from "./tripwire";
import { CANARY_KINDS } from "./tripwire";

export { CANARY_KINDS };

export function isCanaryKind(v: unknown): v is CanaryKind {
  return typeof v === "string" && (CANARY_KINDS as readonly string[]).includes(v);
}

/** Safe to render: no full decoy value. */
export interface CanaryDisplay {
  id: string;
  kind: CanaryKind;
  seededIn: string;
  valueHint: string;
  active: boolean;
  createdAt: string;
}

/** A masked hint - the last 4 characters only, so an operator can recognise a
 *  decoy without the value leaving the store to defeat the deception. */
function hintOf(value: string): string {
  return `****${value.slice(-4)}`;
}

export async function createCanary(input: {
  workspaceId: string;
  kind: CanaryKind;
  value: string;
  seededIn: string;
  createdBy?: string;
}): Promise<CanaryDisplay | null> {
  if (!process.env.DATABASE_URL) return null;
  const value = (input.value ?? "").trim();
  if (!value) throw new Error("value is required");
  if (!input.seededIn?.trim()) throw new Error("seededIn is required");
  if (!isCanaryKind(input.kind)) throw new Error(`unknown canary kind: ${input.kind}`);

  const { rows } = await query<{ id: string; created_at: string }>(
    `INSERT INTO instinct_forcefield_canaries
       (workspace_id, kind, value, seeded_in, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at::text AS created_at`,
    [input.workspaceId, input.kind, value, input.seededIn.trim(), input.createdBy ?? null],
  );
  const row = rows[0];
  if (!row) return null;

  trackEvent("forcefield.canary_seeded", input.createdBy ?? "system", "agent", {
    workspace_id: input.workspaceId,
    kind: input.kind,
    seeded_in: input.seededIn.trim(),
  });

  return {
    id: row.id,
    kind: input.kind,
    seededIn: input.seededIn.trim(),
    valueHint: hintOf(value),
    active: true,
    createdAt: row.created_at,
  };
}

/**
 * INTERNAL. The active decoys with their full values, in the tripwire's Canary
 * shape - fed straight to inspectAgentAction. Never expose this from a response.
 */
export async function listCanariesForMatching(workspaceId: string): Promise<Canary[]> {
  const res = await safeQuery<{ id: string; kind: CanaryKind; value: string; seeded_in: string }>(
    `SELECT id, kind, value, seeded_in
       FROM instinct_forcefield_canaries
      WHERE workspace_id = $1 AND active = true`,
    [workspaceId],
  );
  return res.rows.map((r) => ({ id: r.id, kind: r.kind, value: r.value, seededIn: r.seeded_in }));
}

/** SAFE for a response body: id / kind / where-seeded + a masked hint only. */
export async function listCanariesForDisplay(workspaceId: string): Promise<CanaryDisplay[]> {
  const res = await safeQuery<{
    id: string;
    kind: CanaryKind;
    value: string;
    seeded_in: string;
    active: boolean;
    created_at: string;
  }>(
    `SELECT id, kind, value, seeded_in, active, created_at::text AS created_at
       FROM instinct_forcefield_canaries
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    seededIn: r.seeded_in,
    valueHint: hintOf(r.value),
    active: r.active,
    createdAt: r.created_at,
  }));
}

/** Retire a decoy (soft-disable so it no longer trips). */
export async function deactivateCanary(workspaceId: string, id: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const res = await query(
    `UPDATE instinct_forcefield_canaries SET active = false WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (res.rowCount ?? 0) > 0;
}
