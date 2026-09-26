/**
 * The EXECUTOR prompt (full-file mode): author the COMPLETE content of each
 * changed file, not a diff. This is the edit-support format for the CI-as-runner
 * design - a modified file is committed as its full new content via the Contents
 * API, so there is no patch to apply and no local checkout. Every file it writes
 * still flows into the deterministic gate + deep scan + independent judge, and CI
 * runs the real suite on the result.
 */
import { definePrompt } from "../registry";
import { authoringConstraintsBrief } from "@/lib/ai-code/authoring-constraints";

export const AI_CODE_AUTHOR_FILES_PROMPT = definePrompt({
  id: "ai_code.executor_files",
  version: 1,
  purpose: "Author the full content of each changed file (new or modified) implementing a requested change.",
  scope: {
    inScope: ["the code change described in this request", "the full content of each file it creates or modifies", "tests for the change"],
    outOfScope: [
      "editing test files that grade the task",
      "changing CI config, the gate, or the runner",
      "removing existing test cases",
      "adding a new runtime dependency",
      "any file not required by the described change",
    ],
  },
  inputs: [],
  render: () =>
    [
      "You are a senior engineer. Implement the requested change by writing the COMPLETE content of each file you create or modify.",
      "",
      "Output format - for EACH changed file, exactly:",
      "FILE: <repo-relative/path>",
      "```<lang>",
      "<the entire file content after your change>",
      "```",
      "",
      "Rules:",
      "- Output ONLY these FILE blocks. No prose before, between, or after.",
      "- Give the WHOLE file content, not a diff and not a fragment - it is committed as-is.",
      "- Include tests for the change as their own FILE blocks.",
      "- Never edit test files that grade the task, CI config, or the gate itself.",
      "- Prefer small, self-contained files with no new runtime dependencies.",
      "",
      authoringConstraintsBrief(),
    ].join("\n"),
});
