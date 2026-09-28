/**
 * Classify a CI failure as MECHANICAL (a wrong assertion, a type error, a lint
 * format, a build error - safe for the fixer to auto-repair) vs GOVERNANCE (a
 * guardrail / policy / security check whose "fix" is a judgment call about the
 * product's posture - a human should decide, not an autofixer).
 *
 * Why: dogfooding hit an `audit-coverage` guardrail failure. The RIGHT resolution
 * was a policy decision (allowlist the route vs add a second audit call), not a
 * mechanical patch - so an autofixer must recognize it and escalate, never bolt
 * on a plausible-but-wrong change to make the guardrail pass. Making a governance
 * gate pass by editing code around it is exactly the trust failure this system
 * exists to prevent.
 *
 * Pure and conservative: matches specific governance signals in the failing check
 * names and the failure detail; everything else is mechanical (the fixer's
 * bounded, sandboxed loop handles those safely).
 */

/** Failing-check NAMES that are governance/policy gates by nature. Matched
 *  case-insensitively as substrings of a check/workflow name. */
const GOVERNANCE_CHECK_NAMES = [
  "codeql",
  "static security",
  "pentest",
  "dependency audit",
  "sarif",
  "semgrep",
  "tenant-isolation",
  "secret-scan",
  "license",
];

/** Phrases in the failure DETAIL (the guardrail test's own message) that mean a
 *  governance/policy gate fired - typically our repo-wide coverage/guardrail
 *  tests, which encode a deliberate rule and fail with an actionable policy ask. */
const GOVERNANCE_DETAIL_PATTERNS: RegExp[] = [
  /audit-coverage/i,
  /capability-coverage/i,
  /provider-coverage/i,
  /openapi-coverage/i,
  /\bAUDIT_ALLOWLIST\b/,
  /no-raw-api-fetch/i,
  /no-secret-in-logs/i,
  /no-conflict-markers/i,
  /tenant-isolation/i,
  /must be allowlisted/i,
  /allowlist(ed)? (with|in|entry)/i,
  /guardrail/i,
  /RLS\b|row-level security/i,
];

export type CiFailureKind = "mechanical" | "governance";

export interface CiFailureClass {
  kind: CiFailureKind;
  /** The specific signal that classified it (a check name or a matched phrase),
   *  for the escalation reason + the transparency record. Empty for mechanical. */
  signal: string;
}

/**
 * Classify from the failing check names + the gathered failure detail. Governance
 * wins if ANY governance signal is present (conservative: when a policy gate is
 * involved at all, a human decides). Otherwise mechanical.
 */
export function classifyCiFailure(detail: string, failingChecks: readonly string[] = []): CiFailureClass {
  for (const name of failingChecks) {
    const lc = name.toLowerCase();
    const hit = GOVERNANCE_CHECK_NAMES.find((g) => lc.includes(g));
    if (hit) return { kind: "governance", signal: `check:${name}` };
  }
  for (const re of GOVERNANCE_DETAIL_PATTERNS) {
    const m = detail.match(re);
    if (m) return { kind: "governance", signal: m[0] };
  }
  return { kind: "mechanical", signal: "" };
}
