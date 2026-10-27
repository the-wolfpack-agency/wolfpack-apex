/**
 * The Forcefield Edge service token (apex only).
 *
 * FORCEFIELD_EDGE_SERVICE_TOKEN is the one credential the Edge app holds toward
 * apex. It authorizes exactly two things: reading the site record for a hostname
 * (GET /api/forcefield/edge/site) and posting observations attributed to a named
 * tenant (POST /api/site-analytics/ingest with x-forcefield-edge-tenant). It is
 * separate from FORCEFIELD_EDGE_TOKEN and the shared ingest tokens so it can be
 * rotated, or revoked, without touching any other site.
 *
 * Unset or shorter than 32 characters = the Edge paths are OFF (never open).
 * Compared in constant time through the one shared primitive.
 */
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const EDGE_SERVICE_TOKEN_MIN_LENGTH = 32;

/** True when the Edge service token is configured (long enough to be a secret). */
export function edgeServiceTokenConfigured(): boolean {
  return (process.env.FORCEFIELD_EDGE_SERVICE_TOKEN ?? "").length >= EDGE_SERVICE_TOKEN_MIN_LENGTH;
}

/** Constant-time match of a presented value against the configured token.
 *  False when unconfigured, empty, or different. Never throws. */
export function edgeServiceTokenMatches(presented: string | null | undefined): boolean {
  const expected = process.env.FORCEFIELD_EDGE_SERVICE_TOKEN ?? "";
  if (expected.length < EDGE_SERVICE_TOKEN_MIN_LENGTH || !presented) return false;
  return timingSafeEqualStr(presented, expected);
}
