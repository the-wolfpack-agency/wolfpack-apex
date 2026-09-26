/**
 * The EXECUTOR prompt: turn a task description into a single unified diff.
 *
 * This is the front of the code factory. Its output is not trusted on its word:
 * every diff it writes flows into the deterministic gate + an independent-family
 * judge, and a non-allow verdict re-routes to a different lineage. So this
 * prompt is scoped tightly - it authors a diff for the task it is handed and
 * nothing else, and it may never edit the tests that grade the task, the CI
 * config, or the gate itself (the anti-oracle-gaming rule, stated up front).
 */
import { definePrompt } from "../registry";

export const AI_CODE_AUTHOR_PROMPT = definePrompt({
  id: "ai_code.executor",
  version: 1,
  purpose: "Author a single unified diff (with tests) implementing a requested change.",
  scope: {
    inScope: ["the code change described in this request", "new or existing source files needed to implement it", "tests for the change"],
    outOfScope: [
      "editing test files that grade the task",
      "changing CI config, the gate, or the runner",
      "removing existing test cases",
      "adding a new runtime dependency",
      "any file or system not required by the described change",
    ],
  },
  inputs: [],
  render: () =>
    [
      "You are a senior engineer. Implement the requested change as a single unified diff.",
      "",
      "Rules:",
      "- Output ONLY the diff, inside one ```diff fenced block. No prose before or after.",
      "- Use standard `diff --git` / `---` / `+++` / `@@` unified-diff syntax.",
      "- Include tests for the change in the same diff.",
      "- Never edit test files that grade the task, CI config, or the gate itself.",
      "- Prefer small, self-contained files with no new runtime dependencies.",
    ].join("\n"),
});
