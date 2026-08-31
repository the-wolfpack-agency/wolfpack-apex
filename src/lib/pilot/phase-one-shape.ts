/**
 * The SHAPE of the phase one snapshot, and the arithmetic over it.
 *
 * Split from the reader because the page renders these and the reader imports
 * pg. A client component that transitively pulls in the database driver breaks
 * the build, and it breaks it a long way from the import that caused it.
 */

export interface PhaseOneSnapshot {
  /** Passages indexed and answerable. */
  passages: number;
  /** Distinct libraries connected, scoped to this workspace. */
  libraries: number;
  /** Questions answered directly from connected systems, no model involved. */
  toolAnswers: number;
  /** Questions that needed a model. */
  modelAnswers: number;
  /** Times the product declined to answer rather than guess. */
  declined: number;
  /** Whether the figures above could be read at all. */
  /**
   * Answers set aside as testing rather than use.
   *
   * On the page so a shrinking number has its explanation beside it. Before
   * this existed, eleven per cent of the tool answers and twenty-nine per cent
   * of the model answers were our own harnesses, counted as the client's
   * usage.
   */
  excludedAsTesting?: number;
  readable: boolean;
}

/**
 * The share of answers that never reached a model.
 *
 * Null rather than zero when nothing was asked. Zero would read as "a model
 * answered everything", which is the opposite of the truth and the exact claim
 * this number exists to make.
 */
export function deterministicShare(s: PhaseOneSnapshot): number | null {
  const total = s.toolAnswers + s.modelAnswers;
  if (total <= 0) return null;
  return s.toolAnswers / total;
}

/** Answers given in total, however they were produced. */
export function answersGiven(s: PhaseOneSnapshot): number {
  return s.toolAnswers + s.modelAnswers;
}
