/**
 * Build-time completeness check.
 *
 * Found by dogfooding the factory against apex: the first author emitted a single
 * stray line (`const lines = src.split("\n");`) into a *.test.ts file. It PARSED
 * (valid JS), so the syntax gate passed it and a PR opened - but jest fails such a
 * file with "Your test suite must contain at least one test", so it was never
 * going to be green. Parseability is not completeness.
 *
 * This is the deterministic completeness signal with near-zero false positives: a
 * TEST file must contain at least one test case. It mirrors jest's own rule, and
 * it catches the exact fragment that slipped through. Pure and string-only, so it
 * is fully unit-tested and reused at both the escalation-retry (self-correct) and
 * the final handoff gate (block), the same shape as the syntax + phantom-import
 * checks.
 */

/** A file path that jest treats as a test file (a suite that must contain tests). */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
}

/** A test-runner call that registers at least one test/suite. */
const TEST_CALL = /\b(?:it|test|describe)(?:\.\w+)?\s*\(/;

export interface IncompleteFile {
  path: string;
  reason: string;
}

/**
 * Files that are structurally incomplete for what they claim to be. Today: a test
 * file with no test case (the fragment that passed syntax but can never go green).
 * Pure. Order-preserved.
 */
export function findIncompleteFiles(files: readonly { path: string; content: string }[]): IncompleteFile[] {
  const out: IncompleteFile[] = [];
  for (const f of files) {
    if (isTestFile(f.path) && !TEST_CALL.test(f.content)) {
      out.push({ path: f.path, reason: "test file contains no test case (no it/test/describe) - jest fails it with 'must contain at least one test'" });
    }
  }
  return out;
}

/** Feedback for the authoring retry: name the incomplete files so the model emits
 *  a COMPLETE implementation (real test cases), not a fragment. Pure. */
export function completenessFeedback(incompletes: readonly IncompleteFile[]): string {
  const lines = incompletes.map((i) => `- ${i.path}: ${i.reason}`).join("\n");
  return `The previous attempt is INCOMPLETE - it will fail CI:\n${lines}\nReturn the COMPLETE file(s) with real, executable test cases (describe/it with assertions), not a stub or a fragment.`;
}
