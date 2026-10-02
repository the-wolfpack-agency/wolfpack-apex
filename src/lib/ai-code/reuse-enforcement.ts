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

/**
 * STRONG_DUPLICATION_SCORE: the reuse-scout score at/above which an un-reused top
 * candidate is treated as a likely re-implementation worth a human's eyes. The
 * scout scores a FILENAME concept match at +4, a parent-dir match at +3; 8 means
 * the existing file's NAME matches TWO distinct task concepts (e.g. the prompt
 * said "cost summary" and `cost-summary.ts` already exists). That is a precise,
 * high-confidence signal - below it the coarse score produces noise, which is why
 * enforcement waited for the shadow data (DuplicationSignal) to confirm the line.
 */
export const STRONG_DUPLICATION_SCORE = 8;

export interface DuplicationGate {
  /** Escalate to a human: a strong existing module was NOT reused. */
  escalate: boolean;
  /** The existing module the change most likely re-implements (null when clear). */
  candidatePath: string | null;
  score: number;
  /** Human-readable reason, null when nothing to say. */
  reason: string | null;
}

/**
 * The DRY GATE decision from a duplication signal. Deterministic: escalate when
 * the scout surfaced a STRONG existing module (score >= threshold) that the change
 * did NOT import - i.e. it re-implemented capability that already exists. This is
 * the deterministic control for the duplication incident: the factory flags "this
 * looks like a re-implementation of <path>; reuse it" and withholds the automatic
 * handoff so a human decides, rather than a duplicate silently reaching a PR.
 *
 * It ESCALATES (needs a human), never hard-blocks: the name-match score is a
 * strong hint, not proof, so a human confirms "yes reuse it" or "no, genuinely
 * new". Pure.
 */
export function duplicationGate(
  signal: DuplicationSignal,
  threshold = STRONG_DUPLICATION_SCORE,
): DuplicationGate {
  const escalate = signal.topReused === false && signal.topScore >= threshold;
  return {
    escalate,
    candidatePath: signal.topCandidatePath,
    score: signal.topScore,
    reason: escalate
      ? `This change does not import ${signal.topCandidatePath}, whose name strongly matches the task ` +
        `(reuse score ${signal.topScore}). It likely re-implements capability that already exists - ` +
        `reuse or extend ${signal.topCandidatePath}, or confirm it is genuinely new.`
      : null,
  };
}
