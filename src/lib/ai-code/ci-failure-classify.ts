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

/** A FAILING TEST FILE whose path is a guardrail by NAME - our repo-wide policy /
 *  coverage / architecture rules. Matched against the "FAIL <path>" lines in the
 *  detail. This is the CLASS, so a guardrail we ADD later is covered without
 *  touching the classifier: any `no-*`, `*-coverage`, `*-guard`, `*-posture`, or
 *  `*-conventions` test, plus a few named ones that follow no prefix rule. A
 *  guardrail's "fix" is a human policy decision, never a mechanical patch. */
const GOVERNANCE_TEST_FILE =
  /(?:^|\/)(?:no-[\w-]+|[\w-]*-coverage|[\w-]*-guard|[\w-]*-posture|[\w-]*-conventions|analytics-guard|american-english|audit-log-immutable|db-workspace-scope|events-queries-stay-narrow|dependabot-no-bot-approve|gitattributes-union)\.test\.[tj]sx?/i;

/** Phrases in the failure DETAIL (the guardrail test's own message) that mean a
 *  governance/policy gate fired - it encodes a deliberate rule and fails with an
 *  actionable policy ask ("add to the allowlist", "must import", "is not
 *  registered"). Catches guardrails whose FILE name is not itself a tell. */
const GOVERNANCE_DETAIL_PATTERNS: RegExp[] = [
  // Named coverage/guardrail suites (catch a detail that names one without a
  // "FAIL <path>" line):
  /\b[\w-]*-coverage\b/i,
  /\b[\w-]*-guard\b/i,
  /\bAUDIT_ALLOWLIST\b/,
  /no-raw-api-fetch/i,
  /no-secret-in-logs/i,
  /no-conflict-markers/i,
  /no-sql-injection/i,
  /tenant-isolation/i,
  /guardrail/i,
  /RLS\b|row-level security/i,
  // Actionable policy asks a guardrail test emits:
  /must (?:import|be allowlisted|call|add|register)/i,
  /is not (?:registered|listed|allowlisted|in the allowlist)/i,
  /add (?:an? )?(?:entry|allowlist)/i,
  /is forbidden|not allowed\b/i,
];

/** Infra / transient signals: the job died from the environment, not the code
 *  (a timeout, an OOM, a lost runner, a network blip, a registry 5xx/429). A code
 *  fix is pointless here - the right move is to re-run CI, not author. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b/,
  /the runner has received a shutdown signal/i,
  /no space left on device|ENOSPC/i,
  /out of memory|OOMKilled|JavaScript heap out of memory/i,
  /connection (?:reset|timed out|refused)/i,
  /network (?:error|timeout)|npm ERR! network/i,
  /\b(?:429|503|502|504)\b.*(?:too many requests|service unavailable|bad gateway|gateway time-?out)/i,
  /cannot connect to the docker daemon/i,
  /the operation was canceled|timed out after|timeout exceeded/i,
  /rate limit(?:ed| exceeded)/i,
];

export type CiFailureKind = "mechanical" | "governance" | "transient";

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
  // A failing GUARDRAIL test file (by the naming class) is governance.
  for (const line of detail.split("\n")) {
    const fail = line.match(/FAIL\s+(\S+)/i);
    if (fail && GOVERNANCE_TEST_FILE.test(fail[1])) return { kind: "governance", signal: `guardrail:${fail[1]}` };
  }
  for (const re of GOVERNANCE_DETAIL_PATTERNS) {
    const m = detail.match(re);
    if (m) return { kind: "governance", signal: m[0] };
  }
  // Infra/transient: not a code problem - re-run CI, do not author a fix.
  for (const re of TRANSIENT_PATTERNS) {
    const m = detail.match(re);
    if (m) return { kind: "transient", signal: m[0] };
  }
  return { kind: "mechanical", signal: "" };
}
