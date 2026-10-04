/**
 * Prompt chips - the role/task-annotated starter catalog (the FDOS prompt-registry
 * pattern, brought to the factory). Chips seed the conversation with the kinds of
 * work the factory does, so a user starts from a known-good shape instead of a
 * blank box. Pure + deterministic: a fixed catalog, no model call to produce it.
 */

/** Mirrors the factory's task-type taxonomy (classifyTaskType). */
export type ChipTaskType = "migration" | "api" | "ui" | "test" | "refactor" | "docs" | "ci-fix";

export interface PromptChip {
  id: string;
  /** Short label on the chip. */
  label: string;
  /** The prompt text dropped into the composer when the chip is chosen. */
  prompt: string;
  taskType: ChipTaskType;
  /** One-line client-safe hint of what the factory will do. */
  hint: string;
}

export const PROMPT_CHIPS: readonly PromptChip[] = [
  { id: "migration", label: "Database migration", taskType: "migration",
    prompt: "Add a database migration that ", hint: "Additive, idempotent SQL + a write-read-back test." },
  { id: "api", label: "API route", taskType: "api",
    prompt: "Add an API route at /api/ that ", hint: "Authorized + audited handler; the gate enforces auth." },
  { id: "ui", label: "UI component", taskType: "ui",
    prompt: "Build a UI component that ", hint: "Renders with real state; auth-redirect on protected pages." },
  { id: "test", label: "Tests", taskType: "test",
    prompt: "Write tests that ", hint: "Contract / DB / UI coverage for an existing surface." },
  { id: "refactor", label: "Refactor / dedupe", taskType: "refactor",
    prompt: "Refactor and dedupe ", hint: "The DRY gate blocks a re-implementation of existing code." },
  { id: "docs", label: "Docs", taskType: "docs",
    prompt: "Update the docs / release notes for ", hint: "Documentation only; no behavior change." },
  { id: "ci-fix", label: "Fix a failing check", taskType: "ci-fix",
    prompt: "Fix the failing CI check: ", hint: "Deterministic fixers first, model only when needed." },
];

/** Look a chip up by id (for click -> seed). */
export function chipById(id: string): PromptChip | undefined {
  return PROMPT_CHIPS.find((c) => c.id === id);
}
