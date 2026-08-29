/**
 * Real work from this repo, with the tests that actually graded it.
 *
 * WHY THESE AND NOT A BENCHMARK SET
 *
 * Every task here is a change that was genuinely made in this codebase, and
 * `gradedBy` names the test file that shipped alongside it. So a model is not
 * being asked whether it is clever in general, it is being asked whether it can
 * do the work this team does and survive the gate this team runs. That is the
 * only version of the question that changes a routing decision.
 *
 * HOW A TASK AVOIDS HANDING OVER THE ANSWER
 *
 * `baseCommit` is the commit BEFORE the change landed. The runner builds a
 * worktree there, so the model sees the code as it was, with the bug still in
 * it. The graded test is then copied in from HEAD: the exam paper is brought to
 * the candidate, because it did not exist yet at the base commit.
 *
 * That copy is also why detectOracleGaming matters. The test is sitting right
 * there in the tree, and deleting it passes.
 *
 * ADDING A TASK
 *
 * Find a commit that added a test alongside a source change. baseCommit is its
 * parent, targetFile is the source file, gradedBy is the test. Write the prompt
 * as the request a person would actually have made, describing the problem
 * rather than the solution: a prompt that names the fix is measuring
 * transcription, not engineering.
 */
import type { CodeTask } from "./code-screen";

export const TASKS: CodeTask[] = [
  {
    id: "downgrade",
    baseCommit: "aeeac55a",
    targetFile: "src/lib/ai/models/router.ts",
    gradedBy: ["src/lib/ai/models/__tests__/downgrade-steps-down.test.ts"],
    prompt:
      "There is a bug in model selection. When no model is available at the tier a " +
      "caller asked for, the router falls back to the cheapest model of any tier. " +
      "In production that means a request for the `reasoning` tier is served by " +
      "gpt-4o-mini, the smallest model configured: the caller asked for the most " +
      "capable option and received the least capable one. Fix the fallback so that " +
      "when the required tier is unavailable, the router serves the most capable " +
      "tier that IS available, using cost only to break ties within that tier. It " +
      "must still report that a downgrade happened, and when a small model is " +
      "genuinely the only one configured it must still be returned.",
  },
  {
    id: "sensitive-paste",
    baseCommit: "9d236d2b",
    targetFile: "src/lib/assistant/sensitive-paste.ts",
    gradedBy: ["src/lib/assistant/__tests__/sensitive-paste.test.ts"],
    prompt:
      "When someone pastes a credit card number and nothing else into the assistant, " +
      "we currently pay a model ~1,500 tokens to reply that it cannot process card " +
      "information. The redaction layer has already removed the number before the " +
      "prompt left the process, so the fact is established and we are paying a model " +
      "to phrase it. Create this module exporting `detectSensitivePaste(message)`, " +
      "which returns null for an ordinary message and, for a message that is " +
      "essentially JUST a sensitive value, returns the kinds detected plus a fixed " +
      "answer telling the reader the value was removed before it went anywhere. It " +
      "must NOT fire on a real question that happens to contain a card number, " +
      "because refusing those would be a worse product than the one it replaces. " +
      "Reuse the existing redaction helpers rather than writing a second matcher.",
  },
  {
    id: "capability-denial",
    baseCommit: "31a6f7da",
    targetFile: "src/lib/assistant/capability-denial.ts",
    gradedBy: ["src/lib/assistant/__tests__/capability-denial.test.ts"],
    prompt:
      "This module already builds SQL that filters out cached capability-denial " +
      "answers. We now need a variant for the model-answers table, which has both " +
      "an answer column and a source column. Add an exported function that builds " +
      "the same filter for that table, and make sure an entry written by a human " +
      "is never suppressed by it: only rows whose source is the AI should be " +
      "eligible for suppression. Keep the existing identifier validation so a " +
      "column name cannot be injected.",
  },
];
