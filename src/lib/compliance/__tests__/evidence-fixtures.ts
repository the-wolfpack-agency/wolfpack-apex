/**
 * Shared EvidenceInputs fixtures for the compliance tests.
 *
 * HEALTHY: every control executed inside its window (enforced decisions, signed
 * checkpoints, no plaintext secrets, DB RLS enforced, a live adversarial run).
 * COLD: nothing measured.
 * VACUOUS: the shape that used to read "covered" without any control running -
 * lots of monitor-only traffic, a configured signer that never signed, an
 * encryptor that round-trips while every stored token is plaintext, a committed
 * isolation baseline with USING(true) policies, and a 100% pass on the fixed
 * 8-case regression set. Nothing built from it may read "covered".
 */
import type { EvidenceInputs } from "../types";

export const HEALTHY: EvidenceInputs = {
  auditChainValid: true,
  auditEntries: 1200,
  gateDecisions: 5000,
  gateWouldBlock: 80,
  enforceCapabilities: 6,
  redteamPassRate: 1,
  redteamRecent: true,
  aiSurfacesTotal: 40,
  ungovernedAiSurfaces: 0,
  signingActive: true,
  signingAlgorithm: "ES256",
  secretsEncryptedAtRest: true,
  tenantIsolationEnforced: true,
  tenantScopedTables: 44,
  gateWindowMeasured: true,
  gateWindowDays: 30,
  gateDecisionsWindow: 900,
  gateEnforcedWindow: 400,
  gateEnforcedBlocksWindow: 25,
  gateEnforcedEscalationsWindow: 12,
  gateWouldBlockWindow: 25,
  redteamKind: "live_adversarial",
  redteamCases: 120,
  redteamLastRunAt: "2026-10-24T06:00:00.000Z",
  signingProven: true,
  kekSource: "dedicated",
  storedOauthPlaintext: 0,
  storedConnectorPlaintext: 0,
  dbRlsEnforced: true,
};

export const COLD: EvidenceInputs = {
  auditChainValid: false,
  auditEntries: 0,
  gateDecisions: 0,
  gateWouldBlock: 0,
  enforceCapabilities: 0,
  redteamPassRate: null,
  redteamRecent: false,
  aiSurfacesTotal: 0,
  ungovernedAiSurfaces: 0,
  signingActive: false,
  signingAlgorithm: "none",
  secretsEncryptedAtRest: false,
  tenantIsolationEnforced: false,
  tenantScopedTables: 0,
  gateWindowMeasured: false,
  gateWindowDays: 0,
  gateDecisionsWindow: 0,
  gateEnforcedWindow: 0,
  gateEnforcedBlocksWindow: 0,
  gateEnforcedEscalationsWindow: 0,
  gateWouldBlockWindow: 0,
  redteamKind: null,
  redteamCases: null,
  redteamLastRunAt: null,
  signingProven: false,
  kekSource: "dev-literal",
  storedOauthPlaintext: null,
  storedConnectorPlaintext: null,
  dbRlsEnforced: null,
};

/** Everything that used to pass without the control executing. */
export const VACUOUS: EvidenceInputs = {
  ...HEALTHY,
  // lifetime counts are large, but nothing was enforced in the window
  gateDecisions: 8600,
  gateWouldBlock: 0,
  enforceCapabilities: 0,
  gateDecisionsWindow: 1261,
  gateEnforcedWindow: 0,
  gateEnforcedBlocksWindow: 0,
  gateEnforcedEscalationsWindow: 0,
  gateWouldBlockWindow: 0,
  // a 100% pass on the fixed regression set, run this morning
  redteamKind: "fixed_regression",
  redteamCases: 8,
  redteamPassRate: 1,
  redteamRecent: true,
  // a signer object exists but no checkpoint was ever signed
  signingActive: true,
  signingProven: false,
  // the library round-trips (the old probe-only meaning), but every stored
  // OAuth token is plaintext and the key is the development literal
  secretsEncryptedAtRest: true,
  storedOauthPlaintext: 6,
  kekSource: "dev-literal",
  // the committed guardrail baseline says enforced; the DB says USING(true)
  tenantIsolationEnforced: true,
  dbRlsEnforced: false,
};
