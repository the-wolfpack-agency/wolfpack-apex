/**
 * Security-surface guard for a SELF-HOSTING factory. When the factory authors a
 * change to apex itself, a change that touches the PROTECTIONS - the gate's own
 * detectors, the guardrail tests/allowlists, the CSP/auth/crypto layer, the OGIAM
 * PEP, or the CI gate - could silently WEAKEN them and then pass the (now-weaker)
 * checks. So touching the security surface forces needs_human: a human confirms
 * the factory is improving its gate, not loosening it. It never BLOCKS (the
 * factory may improve its own protections); it just denies the silent auto-PR.
 *
 * Precise + low-false-positive: only the real control surface matches; ordinary
 * routes/libs/components do not.
 */
const SECURITY_SURFACE: readonly RegExp[] = [
  /^src\/middleware\.ts$/, // CSP, security headers, the Forcefield guard
  /^src\/lib\/auth\//, // capability gate + require-capability + the workspace chokepoint
  /^src\/lib\/crypto\//, // signing / JWT / cookies
  /^src\/lib\/ogiam\//, // the authorize + hash-chained ledger PEP
  /^src\/lib\/gates\//, // the gate registry (incl. pre-pr-validate)
  /^src\/lib\/platform-scan\/static\//, // the shared deep scanner
  /^src\/lib\/ai-code\/(detect|deep-scan|gate|destructive-sql|reuse-scout|pre-pr-validation|open-pr-executor|security-surface)\.ts$/, // the gate itself
  /coverage\.test\.ts$/, // capability/audit/openapi coverage guardrails
  /^src\/__tests__\/(no-raw-api-fetch|no-secret-in-logs|no-dormant-specs|tenant-isolation)/, // guardrail tests
  /tenant-isolation.*\.test\.ts$/,
  /^\.github\/workflows\/(verify|factory-validate|db-contract|codeql|security)/, // the CI gate
  /^scripts\/verify\.sh$/,
];

/** The security-critical paths a change touches (empty = none). */
export function touchesSecuritySurface(paths: readonly string[]): string[] {
  return paths.filter((p) => SECURITY_SURFACE.some((re) => re.test(p)));
}
