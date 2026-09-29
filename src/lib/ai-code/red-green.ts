/**
 * Red-before-green verification for FIX tasks: the deterministic core.
 *
 * A bug fix is only PROVEN if its test fails on the unfixed code and passes on
 * the fixed code. Dogfooding found why this matters: routing an extraction fix
 * through the factory produced a plausible-but-wrong change (it patched the wrong
 * filter) with NO test, so nothing proved it and CI could pass it green by
 * omission. Requiring the change's reproducing test to go red -> green turns
 * "correctness" into a deterministic check instead of a reviewer's judgment.
 *
 * It also defeats the self-consistency trap (a model writing a test that agrees
 * with its own wrong fix): a test that PASSES on the unfixed base does not
 * reproduce the bug and is rejected, no matter how green it looks after.
 *
 * This module is the PURE decision over the two test outcomes. Producing those
 * outcomes (run the change's test against base-without-fix, then against head) is
 * a CI operation the workflow wiring supplies; keeping the decision pure makes it
 * fully unit-testable and reusable by both the CI check and the authoring retry.
 */

export interface RedGreenEvidence {
  /** The change's reproducing test, run against the BASE code with ONLY the test
   *  applied and the fix withheld. Must FAIL - that is what proves the test
   *  actually reproduces the bug rather than passing regardless. */
  failedOnBase: boolean;
  /** The full change (test + fix) run against HEAD. Must PASS. */
  passedOnHead: boolean;
}

export interface RedGreenVerdict {
  /** True only for a genuine red-to-green: failed on the unfixed base, passes after the fix. */
  ok: boolean;
  reason: string;
}

/**
 * Decide whether a fix is proven by its reproducing test. Pure and total over the
 * four outcome combinations.
 */
export function evaluateRedGreen(e: RedGreenEvidence): RedGreenVerdict {
  if (e.failedOnBase && e.passedOnHead) {
    return { ok: true, reason: "The test fails on the unfixed base and passes after the fix (red -> green): the fix is proven." };
  }
  if (!e.failedOnBase && e.passedOnHead) {
    return { ok: false, reason: "The test PASSES on the unfixed base, so it does not reproduce the bug and cannot prove the fix (it would pass even without it). Write a test that FAILS on the current code and passes after the fix." };
  }
  if (e.failedOnBase && !e.passedOnHead) {
    return { ok: false, reason: "The reproducing test still FAILS after the fix: the bug is not actually fixed." };
  }
  return { ok: false, reason: "The test fails both before and after the fix: it is broken or unrelated to the change, and proves nothing." };
}

/** Feedback for the authoring retry when red-before-green is not satisfied. Pure. */
export function redGreenFeedback(v: RedGreenVerdict): string {
  return `The fix is not proven by a red-to-green test. ${v.reason} Return the change with a test that fails on the current code and passes only after your fix.`;
}
