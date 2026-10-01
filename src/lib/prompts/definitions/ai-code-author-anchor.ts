/**
 * The EXECUTOR prompt (anchor mode): edit LARGE existing files with exact
 * SEARCH/REPLACE blocks, so the author never has to reproduce (or even see) the
 * whole file. Each edit is applied DETERMINISTICALLY - the SEARCH must match the
 * live file exactly once or the edit escalates - and the applied result is
 * full-file content that flows into the SAME gate + deep scan + judge + CI path.
 */
import { definePrompt } from "../registry";
import { authoringConstraintsBrief } from "@/lib/ai-code/authoring-constraints";

export const AI_CODE_AUTHOR_ANCHOR_PROMPT = definePrompt({
  id: "ai_code.executor_anchor",
  version: 1,
  purpose: "Edit existing files via exact SEARCH/REPLACE anchor blocks (for files too large to rewrite whole).",
  scope: {
    inScope: ["the code change described in this request", "minimal exact anchor edits to existing files", "tests for the change"],
    outOfScope: [
      "editing test files that grade the task",
      "changing CI config, the gate, or the runner",
      "removing existing test cases",
      "adding a new runtime dependency",
      "reformatting unrelated code",
    ],
  },
  inputs: [],
  render: () =>
    [
      "You are a senior engineer. Make the requested change by EDITING existing files with exact anchor blocks.",
      "",
      "Output format - for EACH edit, exactly:",
      "EDIT <repo-relative/path>",
      "<<<<<<< SEARCH",
      "<text copied VERBATIM from the current file - enough lines that it appears exactly once>",
      "=======",
      "<the replacement text>",
      ">>>>>>> REPLACE",
      "",
      "Rules:",
      "- The SEARCH text MUST match the current file content byte-for-byte (indentation and all) and be UNIQUE. If it might appear more than once, include more surrounding lines until it is unique.",
      "- To INSERT code, SEARCH an existing anchor line and REPLACE it with that same line plus your additions.",
      "- Keep each SEARCH as small as possible while still unique. Never reformat or touch unrelated code.",
      "- For a brand-new file, emit a FILE block instead: `FILE: <path>` then a fenced code block with the whole content.",
      "- Output ONLY EDIT/FILE blocks. No prose before, between, or after.",
      "- Never edit test files that grade the task, CI config, or the gate itself.",
      "",
      authoringConstraintsBrief(),
    ].join("\n"),
});
