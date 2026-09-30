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

/** True when a failing check is the dependency-audit gate specifically. It is a
 *  governance gate (never let a model hack it), but UNLIKE a guardrail - whose fix
 *  is a human policy decision - a dependency advisory with a patched version has a
 *  DETERMINISTIC remediation (a targeted lockfile bump). So the loop can dispatch a
 *  no-model dep-fixer instead of spending a human, and only escalate when no fix is
 *  available. Pure. */
export function isDependencyAuditFailure(failedChecks: readonly string[]): boolean {
  return failedChecks.some((n) => /dependency audit/i.test(n));
}

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

/** Check NAMES that run CODE (a compiler, a linter, a test runner). A failure
 *  here is code-fixable even if our log extractor happened to miss the error
 *  text, so empty detail on one of these must NOT be treated as "infra". */
const CODE_CHECK_NAMES = ["unit", "test", "jest", "lint", "type", "tsc", "typecheck", "build", "compile", "vitest", "coverage"];

/** Check NAMES that are deploy / setup / infra by nature - they fail before any
 *  code assertion runs (a deploy, a preview, an e2e harness that never starts, a
 *  preflight gate). Empty detail on one of THESE means infra failed, not that we
 *  missed a code error. */
const INFRA_CHECK_NAMES = ["e2e", "deploy", "vercel", "preflight", "canary", "playwright", "lighthouse", "smoke", "provision"];

/** True when a failing check is a deploy/infra check and NOT a code check. Code
 *  wins ties (a "unit-e2e" check is code), so this is conservative: it only calls
 *  a check infra when it clearly is. Pure. */
export function isDeployInfraCheck(name: string): boolean {
  const lc = name.toLowerCase();
  if (CODE_CHECK_NAMES.some((c) => lc.includes(c))) return false;
  return INFRA_CHECK_NAMES.some((i) => lc.includes(i));
}

/** True when EVERY failing check is a deploy/infra check (none code-oriented), so
 *  an empty failure detail means "infra failed before any code ran", not "our
 *  extractor missed a code error". Only then is escalate-without-authoring right;
 *  otherwise the fixer should still try (anchored to the change's files). Found by
 *  dogfooding apex: a `unit`/`lint-types` failure with empty detail must NOT be
 *  escalated as infra - it is a real code failure whose log we simply did not
 *  parse. Pure. */
export function failuresAreInfraOnly(checks: readonly string[]): boolean {
  return checks.length > 0 && checks.every(isDeployInfraCheck);
}

export type CiFailureKind = "mechanical" | "governance" | "transient";

/** The specific shape of a MECHANICAL failure, so the fixer can route it: a
 *  snapshot must NOT be blindly updated (it masks a regression), a type/import
 *  error gets a tailored fix, a lint/format issue is a mechanical cleanup. */
export type MechanicalSubtype = "lint" | "type" | "import" | "snapshot" | "coverage" | "build" | "test";

export interface CiFailureClass {
  kind: CiFailureKind;
  /** The specific signal that classified it (a check name or a matched phrase),
   *  for the escalation reason + the transparency record. Empty for mechanical. */
  signal: string;
  /** For a mechanical failure, its shape (so the fixer routes it). Undefined for
   *  governance/transient. */
  subtype?: MechanicalSubtype;
}

/** Patterns that identify a mechanical failure's SUBTYPE from the log detail.
 *  Order matters: the most specific/dangerous (snapshot) is checked first. */
const SUBTYPE_PATTERNS: { subtype: MechanicalSubtype; re: RegExp }[] = [
  { subtype: "snapshot", re: /\bsnapshot\b|toMatchSnapshot|obsolete snapshot|snapshots? (?:failed|obsolete)|to update them/i },
  { subtype: "coverage", re: /coverage threshold|does not meet.*coverage|Jest:.*coverage|Coverage for \w+ \(/i },
  { subtype: "type", re: /error TS\d|Type error:|is not assignable to|implicitly has an? '?any|Property '[^']+' does not exist on type|Object is possibly/i },
  { subtype: "import", re: /Cannot find module|Module not found|has no exported member|Cannot find name '[^']+'/i },
  { subtype: "lint", re: /\beslint\b|prettier|Parsing error:|no-unused-vars|prefer-const|@typescript-eslint\/|Insert `|Delete `|Replace `/i },
  { subtype: "build", re: /Failed to compile|Build error|next build|webpack (?:error|compiled with)/i },
];

/** Identify a mechanical failure's subtype from the detail (default "test"). Pure. */
export function mechanicalSubtype(detail: string): MechanicalSubtype {
  for (const { subtype, re } of SUBTYPE_PATTERNS) if (re.test(detail)) return subtype;
  return "test";
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
  return { kind: "mechanical", signal: "", subtype: mechanicalSubtype(detail) };
}
