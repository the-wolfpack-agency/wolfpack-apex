/**
 * Adversarial corpus - the shared fixture behind the efficacy proofs.
 *
 * One set of cases spanning every failure mode we know: good code that should
 * be ACCEPTED, bad code that must be REJECTED, and clean-but-off-spec changes
 * that must be FLAGGED. Extracted here (not inlined in one test) so both proofs
 * consume the SAME cases - the pipeline corpus (accept/reject/flag through the
 * full pipeline) and the multi-model matrix (the gate verdict is identical no
 * matter which model authored the change). DRY: add a case once, both proofs
 * cover it.
 */

/** Build a minimal unified diff that adds `lines` to `path`. */
export function fileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${lines.length + 1} @@`,
    " existing",
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

export const combine = (...d: string[]) => d.join("\n");

// Reusable diff pieces.
export const UNIT = fileDiff("src/lib/thing/__tests__/thing.test.ts", ["it('works', () => {});"]);
export const CONTRACT = fileDiff("src/app/api/thing/__tests__/route.test.ts", ["it('200', () => {});"]);
export const E2E = fileDiff("tests/e2e/thing.spec.ts", ["test('flow', async () => {});"]);
export const CODE = fileDiff("src/lib/thing/thing.ts", ["export const x = 1;"]);
export const CODE_WITH_ANALYTICS = fileDiff("src/lib/thing/thing.ts", ["trackEvent('thing.done', u, r, {});"]);

export interface Case {
  name: string;
  diff: string;
  answers: Record<string, string>;
  expect: { status: "ready_for_pr" | "needs_human"; conforms: boolean; deviation?: string };
}

export const CORPUS: Case[] = [
  // ---- ACCEPT: good code with the process it committed to ----
  {
    name: "clean feature, full test coverage, analytics wired, reversible",
    diff: combine(UNIT, CONTRACT, E2E, CODE_WITH_ANALYTICS),
    answers: { tests: "all", data: "analytics", reversibility: "reversible" },
    expect: { status: "ready_for_pr", conforms: true },
  },

  // ---- REJECT bad CODE: the security gate stops it, and no repair talks past it ----
  {
    name: "hardcoded secret (critical)",
    diff: fileDiff("src/config.ts", ['const apiKey = "aVerySecretValue12345";']),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },
  {
    name: "reset link written to a log (the origin incident)",
    diff: fileDiff("src/auth.ts", ['console.log("password reset:", resetUrl);']),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },
  {
    name: "dynamic code execution (eval)",
    diff: fileDiff("src/run.ts", ["eval(req.body.code);"]),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },
  {
    name: "TLS verification disabled",
    diff: fileDiff("src/http.ts", ["const agent = new https.Agent({ rejectUnauthorized: false });"]),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },

  // ---- FLAG bad PROCESS: gate is clean, but the change breaks its own spec ----
  {
    name: "gate-clean but skips the required test coverage",
    diff: CODE_WITH_ANALYTICS, // no test files
    answers: { tests: "all", data: "analytics" },
    expect: { status: "ready_for_pr", conforms: false, deviation: "tests" },
  },
  {
    name: "gate-clean but does not wire the promised analytics",
    diff: combine(UNIT, CODE), // a test, but no trackEvent
    answers: { tests: "unit", data: "analytics" },
    expect: { status: "ready_for_pr", conforms: false, deviation: "data" },
  },
  {
    name: "gate-clean but adds an unguarded migration where the spec said guarded",
    diff: combine(UNIT, fileDiff("db/migrations/900_x.sql", ["CREATE TABLE t ();"])),
    answers: { tests: "unit", reversibility: "guarded" },
    expect: { status: "ready_for_pr", conforms: false, deviation: "reversibility" },
  },
];
