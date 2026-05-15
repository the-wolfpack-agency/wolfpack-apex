/**
 * Eval-harness runner — assertion library.
 *
 * Pure: takes an EvalCase and the actual chat() result and returns
 * pass/fail with human-readable reasons. The Jest harness in
 * src/lib/assistant/__tests__/eval-harness.test.ts wires mocks and
 * calls chat() per case; this module just decides whether the result
 * passes the case's expectations.
 *
 * Separated from the test file so a future ad-hoc CLI (run the corpus
 * against a live assistant in shadow mode) can reuse the same
 * assertion semantics without depending on Jest globals.
 */

import type { AssistantResponse } from "@/lib/assistant";
import type { EvalCase, EvalCaseResult } from "./types";

export function assertEvalCase(
  c: EvalCase,
  result: AssistantResponse,
): EvalCaseResult {
  const failures: string[] = [];
  const e = c.expect;

  if (e.source !== undefined && result.source !== e.source) {
    failures.push(`expected source="${e.source}", got "${result.source}"`);
  }

  if (e.sourceNot !== undefined) {
    for (const forbidden of e.sourceNot) {
      if (result.source === forbidden) {
        failures.push(`source must not be "${forbidden}" (it was)`);
      }
    }
  }

  const response = result.response ?? "";
  const lowered = response.toLowerCase();

  if (e.answerContains !== undefined) {
    for (const phrase of e.answerContains) {
      if (!lowered.includes(phrase.toLowerCase())) {
        failures.push(`answer missing required phrase: "${phrase}"`);
      }
    }
  }

  if (e.answerNotContains !== undefined) {
    for (const phrase of e.answerNotContains) {
      if (lowered.includes(phrase.toLowerCase())) {
        failures.push(`answer contains forbidden phrase: "${phrase}"`);
      }
    }
  }

  return {
    caseId: c.id,
    passed: failures.length === 0,
    failures,
    sourceActual: String(result.source),
    sourceExpected: e.source,
  };
}
