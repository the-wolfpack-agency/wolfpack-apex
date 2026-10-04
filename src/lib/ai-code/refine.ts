/**
 * Iterative refinement - the #1 daily-driver gap vs comparable tools (Cursor/
 * Devin let you say "no, do X instead" in place). Rather than start a fresh run,
 * the user passes the PRIOR change + a refinement instruction, and the factory
 * authors a REVISION. This is pure prompt composition: the existing authoring +
 * the FULL gate (deep-scan, tier-2, invariants) run on the revision exactly as on
 * a first draft, so a refinement is never less-governed than an original.
 */
const REFINE_CAP = 24000; // cap the prior change so a huge paste never bloats the prompt

/** Compose the authoring prompt for a refinement. With no prior change it is a
 *  pass-through (an ordinary first run); with one, it instructs a complete
 *  revision (not a delta) so the author returns a full, re-gatable change. */
export function composeRefinePrompt(instruction: string, priorChange?: string, cap = REFINE_CAP): string {
  const prior = (priorChange ?? "").trim();
  if (!prior) return instruction;
  const bounded = prior.length > cap ? `${prior.slice(0, cap)}\n… (truncated)` : prior;
  return [
    "Revise the EXISTING change below according to the instruction. Return the COMPLETE revised change (the full new version), never just a delta or a description of edits.",
    "",
    "EXISTING CHANGE:",
    bounded,
    "",
    "INSTRUCTION:",
    instruction,
  ].join("\n");
}
