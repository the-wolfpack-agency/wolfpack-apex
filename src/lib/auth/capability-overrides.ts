/**
 * Per-user capability overrides — persisted in the
 * `apex_team_members.capability_overrides` JSONB column (migration 021).
 *
 * Shape stored in the DB:
 *
 *   {
 *     "grants":  ["finance.reports.view"],
 *     "revokes": ["docs.edit"],
 *     "expires": { "finance.reports.view": "2026-05-01T00:00:00Z" }
 *   }
 *
 * Resolver rule:
 *   effective = (role_defaults ∪ grants) \ revokes
 *   grants with an entry in `expires` that is in the past are ignored.
 *
 * All mutations are DB-persisted — never in-memory maps.
 */

import type { Capability } from "./capabilities";
import { isCapability } from "./capabilities";
import { capabilitiesForRole } from "./role-capabilities";
import { query, safeQuery } from "@/lib/db";

export interface CapabilityOverrides {
  grants: Capability[];
  revokes: Capability[];
  /** ISO-8601 expiry per granted capability. Missing = never expires. */
  expires: Partial<Record<Capability, string>>;
}

export function emptyOverrides(): CapabilityOverrides {
  return { grants: [], revokes: [], expires: {} };
}

/**
 * Validate + normalize an untrusted overrides blob read from the DB.
 * Unknown keys are stripped so that a stale schema can't poison the resolver.
 */
export function normalizeOverrides(raw: unknown): CapabilityOverrides {
  const out = emptyOverrides();
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.grants)) {
    for (const g of obj.grants) if (isCapability(g)) out.grants.push(g);
  }
  if (Array.isArray(obj.revokes)) {
    for (const r of obj.revokes) if (isCapability(r)) out.revokes.push(r);
  }
  if (obj.expires && typeof obj.expires === "object") {
    for (const [k, v] of Object.entries(obj.expires as Record<string, unknown>)) {
      if (isCapability(k) && typeof v === "string") {
        out.expires[k] = v;
      }
    }
  }
  return out;
}

/**
 * Compute the effective capability set for a user given role + overrides.
 * Expired grants are dropped at resolution time (no write-back here — a
 * separate sweep job may GC the expires map later).
 */
export function resolveCapabilities(
  role: string,
  overrides: CapabilityOverrides,
  now: Date = new Date(),
): Set<Capability> {
  const base = new Set<Capability>(capabilitiesForRole(role));
  for (const g of overrides.grants) {
    const exp = overrides.expires[g];
    if (exp) {
      const expAt = new Date(exp);
      if (isFinite(expAt.getTime()) && expAt.getTime() <= now.getTime()) {
        continue; // expired grant → ignore
      }
    }
    base.add(g);
  }
  for (const r of overrides.revokes) {
    base.delete(r);
  }
  return base;
}

/**
 * Per-capability source trace — useful for the admin UI and the
 * `/api/admin/users/[id]/capabilities` response.
 */
export type CapabilitySource = "role" | "grant" | "revoked" | "expired-grant";

export interface CapabilityTrace {
  capability: Capability;
  source: CapabilitySource;
  expiresAt?: string;
}

export function traceCapabilities(
  role: string,
  overrides: CapabilityOverrides,
  now: Date = new Date(),
): CapabilityTrace[] {
  const roleCaps = capabilitiesForRole(role);
  const out: CapabilityTrace[] = [];
  const revokedSet = new Set(overrides.revokes);

  for (const c of roleCaps) {
    if (revokedSet.has(c)) out.push({ capability: c, source: "revoked" });
    else out.push({ capability: c, source: "role" });
  }

  for (const g of overrides.grants) {
    const exp = overrides.expires[g];
    let expired = false;
    if (exp) {
      const expAt = new Date(exp);
      if (isFinite(expAt.getTime()) && expAt.getTime() <= now.getTime()) expired = true;
    }
    if (revokedSet.has(g)) {
      // grant trumped by revoke — record as revoked (already may be present)
      if (!out.some((t) => t.capability === g)) out.push({ capability: g, source: "revoked" });
      continue;
    }
    if (expired) {
      out.push({ capability: g, source: "expired-grant", expiresAt: exp });
      continue;
    }
    // Only add "grant" if not already present via role
    if (!out.some((t) => t.capability === g)) {
      out.push({ capability: g, source: "grant", expiresAt: exp });
    }
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fetch a user's role + stored overrides. Returns null if the user does
 * not exist. In shadow mode (no DATABASE_URL) returns null so callers
 * fall back to role defaults only.
 */
export async function loadUserOverrides(
  userId: string,
): Promise<{ role: string; overrides: CapabilityOverrides } | null> {
  if (!process.env.DATABASE_URL) return null;
  const { rows } = await safeQuery<{ role: string; capability_overrides: unknown }>(
    `SELECT role, capability_overrides
       FROM apex_team_members
      WHERE id = $1 AND is_active = true`,
    [userId],
  );
  if (rows.length === 0) return null;
  return {
    role: rows[0].role,
    overrides: normalizeOverrides(rows[0].capability_overrides),
  };
}

/**
 * Persist the full overrides blob for a user. Called by the admin API
 * after a grant / revoke mutation. Returns false if the update affected 0
 * rows (user not found / inactive).
 */
export async function saveUserOverrides(
  userId: string,
  overrides: CapabilityOverrides,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const result = await query(
    `UPDATE apex_team_members
        SET capability_overrides = $2::jsonb
      WHERE id = $1 AND is_active = true`,
    [userId, JSON.stringify(overrides)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Atomically add a grant (idempotent — duplicate grants are collapsed).
 * Removes the capability from `revokes` if it was there so a grant
 * always "wins" the write it was explicitly performed for.
 */
export function applyGrant(
  overrides: CapabilityOverrides,
  capability: Capability,
  expiresAt?: string,
): CapabilityOverrides {
  const next: CapabilityOverrides = {
    grants: [...overrides.grants],
    revokes: overrides.revokes.filter((r) => r !== capability),
    expires: { ...overrides.expires },
  };
  if (!next.grants.includes(capability)) next.grants.push(capability);
  if (expiresAt) next.expires[capability] = expiresAt;
  else delete next.expires[capability];
  return next;
}

/**
 * Remove a grant and record a revoke. Idempotent.
 */
export function applyRevoke(
  overrides: CapabilityOverrides,
  capability: Capability,
): CapabilityOverrides {
  const next: CapabilityOverrides = {
    grants: overrides.grants.filter((g) => g !== capability),
    revokes: [...overrides.revokes],
    expires: { ...overrides.expires },
  };
  delete next.expires[capability];
  if (!next.revokes.includes(capability)) next.revokes.push(capability);
  return next;
}
