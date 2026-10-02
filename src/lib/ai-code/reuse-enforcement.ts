/**
 * Duplication detection (SHADOW first) - did the change re-implement capability
 * that already exists instead of reusing it?
 *
 * Found by dogfooding: asked to "reuse the existing grading logic", a model
 * authored its own `report()` and even hallucinated a grader rather than import
 * the real `gradeRuns`. The deterministic gates catch a BROKEN import; they do
 * not catch a CLEAN re-implementation of something that already exists - the DRY
 * failure that caused real pain earlier (a second cost summary when one existed).
 *
 * This is deliberately NOT a blocking gate yet. The reuse-scout score is coarse,
 * so a threshold guessed today would produce noisy false escalations. Instead we
 * RECORD the raw signal on every run - the top reuse candidate's score, and
 * whether the change actually imported it - so the grading data shows how often a
 * high-confidence module goes unreused and at what score an escalation would be
 * right. Enforcement (escalate-not-block) follows the data, not a guess.
 *
 * Pure; reuses extractLocalImports (imports.ts) + toImportSpecifier
 * (export-grounding.ts).
 */
import { extractLocalImports } from "./imports";
import { toImportSpecifier } from "./export-grounding";

/** Every local import specifier the change makes (deduped). Pure. */
export function changeImportSpecifiers(files: readonly { path: string; content: string }[]): Set<string> {
  const specs = new Set<string>();
  for (const f of files) for (const li of extractLocalImports(f.path, f.content)) specs.add(li.spec);
  return specs;
}

/**
 * Did the change import from the module at `candidatePath`? Compares the
 * candidate's import specifier (via the alias map) against what the change
 * imports. Pure.
 */
export function changeImportsPath(
  files: readonly { path: string; content: string }[],
  candidatePath: string,
  aliasMap: Record<string, string>,
): boolean {
  const specifier = toImportSpecifier(candidatePath, aliasMap);
  return changeImportSpecifiers(files).has(specifier);
}

export interface DuplicationSignal {
  /** The highest-scoring existing module the reuse-scout surfaced (null if none). */
  topCandidatePath: string | null;
  /** Its reuse-scout score (0 when none). */
  topScore: number;
  /** Whether the change imported from it. null when there was no candidate. */
  topReused: boolean | null;
}

/**
 * The shadow signal for one run: the top reuse candidate, its score, and whether
 * the change reused it. A high score that was NOT reused is a likely duplication.
 * Pure. `candidates` are reuse-scout results (already sorted, highest first).
 */
export function duplicationSignal(
  candidates: readonly { path: string; score: number }[],
  files: readonly { path: string; content: string }[],
  aliasMap: Record<string, string>,
): DuplicationSignal {
  const top = candidates[0];
  if (!top) return { topCandidatePath: null, topScore: 0, topReused: null };
  return {
    topCandidatePath: top.path,
    topScore: top.score,
    topReused: changeImportsPath(files, top.path, aliasMap),
  };
}
