/**
 * Instinct — runtime feature flags.
 *
 * Tiny, type-safe env-flag helpers. These are NOT analytics and NOT
 * persisted; they're deployment-time toggles for compliance-light
 * client deployments.
 *
 * Design:
 *   - Flags default to the INTERNAL (Wolfpack) deployment behavior.
 *     Compliance-light client deployments flip them OFF via env.
 *   - Only the exact strings "false" / "0" (case-insensitive) disable
 *     a default-on flag. Anything else (including garbage values) keeps
 *     the default — fail-open to enabled — so a typo can never silently
 *     disable writes for the internal team.
 *
 * Keep this module surface intentionally small. Add new flags only
 * when the branching is irreducible; prefer configuration tables in DB
 * for anything that can evolve per-tenant.
 */

/**
 * Parse an env-style boolean defaulting to `true`.
 *
 * - unset / empty / undefined      → true
 * - "false" / "0" (any case)       → false
 * - anything else                  → true
 */
function parseEnvBoolDefaultTrue(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return true;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return true;
  const lowered = trimmed.toLowerCase();
  if (lowered === "false" || lowered === "0") return false;
  return true;
}

/**
 * Is the Teams write path (inline send / reply) enabled for this
 * deployment? Defaults to true (internal Wolfpack deployment); set
 * `INSTINCT_TEAMS_WRITE_ENABLED=false` to disable for compliance-light
 * client deployments.
 */
export function isTeamsWriteEnabled(): boolean {
  return parseEnvBoolDefaultTrue(process.env.INSTINCT_TEAMS_WRITE_ENABLED);
}
