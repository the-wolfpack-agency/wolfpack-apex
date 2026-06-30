/**
 * Merge-order planner for the Production Release Gate.
 *
 * THE PROBLEM THIS SOLVES
 *
 *   The release gate lists every open change waiting to ship, but gives no ORDER.
 *   When several are ready at once, an operator approves them in an arbitrary
 *   order; any two that touch the same file then collide, and the second, third,
 *   ... merges hit a conflict that has to be hand-resolved. The fix is to make the
 *   safe order VISIBLE: which change to promote first, which are independent (zero
 *   risk, any order), and which will need a quick rebase after an earlier one lands
 *   (and on which files, so the operator knows whether it is a trivial union).
 *
 * This is a PURE function over the gate's blocking list + each ready change's
 * changed-file paths, so it is fully unit-testable with no network. The route
 * fetches the file lists (see fetchChangedFilesByPr in release-gate.ts) and feeds
 * them in.
 *
 * It never claims certainty it does not have: two changes that touch the same file
 * MIGHT not textually conflict, so the language is "merge after, expect a possible
 * quick rebase," and for the known append-only hot files (the analytics union, the
 * audit allowlist, the e2e spec list, the generated tenant baseline) it says so
 * explicitly, because those rebases are reliably a one-line union.
 */

import type { BlockingChange } from "./release-gate";

/**
 * Files that multiple changes append to by design, where a "conflict" is almost
 * always a trivial union (add both sides' lines). Naming them lets the planner
 * tell the operator "this is a 30-second union rebase," not "danger."
 */
export const APPEND_ONLY_HOT_FILES: readonly string[] = [
  "src/lib/analytics.ts",
  "src/__tests__/AUDIT_ALLOWLIST.ts",
  ".github/workflows/e2e-reality-check.yml",
  "src/lib/db/__generated__/tenant-isolation-baseline.json",
  "vercel.json",
];

/** One change's place in the recommended promotion order. */
export interface MergeStep {
  number: number;
  title: string;
  url: string;
  /** Plain-language gate state reason, carried through from the gate. */
  reason: string;
  /** True only for ready_to_merge changes (the promotable ones). */
  ready: boolean;
  /** 1-based promotion order among READY changes; null when not ready. */
  order: number | null;
  /** Shares no changed file with any other blocking change (zero merge risk). */
  independent: boolean;
  /**
   * Ready changes ordered BEFORE this one that share a file with it. Promote
   * those first; then this one needs a (usually trivial) rebase.
   */
  rebaseAfter: number[];
  /** The union of files this change shares with any other blocking change. */
  sharedFiles: string[];
  /** Operator-facing, plain-language guidance for this step. */
  note: string;
}

/** The whole plan: an ordered, annotated promotion sequence. */
export interface MergePlan {
  steps: MergeStep[];
  readyCount: number;
  /** Ready changes that share no files with any other (safe in any order). */
  independentCount: number;
  /** True if any two blocking changes share a file (an order actually matters). */
  hasOverlaps: boolean;
  /**
   * Set IFF we could not determine file overlaps (file lists unavailable). The
   * order then falls back to oldest-ready-first and callers MUST surface that the
   * overlap analysis is incomplete - never imply "no conflicts" when unknown.
   */
  degraded?: { detail: string };
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(a);
  return b.filter((p) => set.has(p));
}

function allHot(files: readonly string[]): boolean {
  const hot = new Set(APPEND_ONLY_HOT_FILES);
  return files.length > 0 && files.every((f) => hot.has(f));
}

/** Short basename-ish label so notes stay readable (keep the meaningful tail). */
function shortFile(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

function buildNote(step: {
  ready: boolean;
  order: number | null;
  independent: boolean;
  rebaseAfter: number[];
  sharedFiles: string[];
  reason: string;
}): string {
  if (!step.ready) {
    // Not promotable yet: the gate reason IS the instruction (resolve it first).
    return `Resolve first: ${step.reason}.`;
  }
  if (step.independent) {
    return "Independent - touches no files another open change touches. Safe to promote in any order.";
  }
  if (step.rebaseAfter.length === 0) {
    // Overlaps exist but only with changes ordered AFTER this one, so this one
    // merges clean and the others rebase onto it.
    return "Promote first of its overlapping group - it merges clean; the others rebase onto it.";
  }
  const after = step.rebaseAfter.map((n) => `#${n}`).join(", ");
  const files = step.sharedFiles.map(shortFile).join(", ");
  if (allHot(step.sharedFiles)) {
    return `Promote after ${after}, then a one-line union rebase on append-only files (${files}).`;
  }
  return `Promote after ${after}, then rebase and re-check - shares ${files}.`;
}

/**
 * Compute the recommended promotion order.
 *
 * Order policy (deterministic, explainable):
 *   1. Only READY changes get an order. Non-ready changes are listed with a
 *      "resolve first" note and order=null (you cannot promote them anyway).
 *   2. Among ready changes: INDEPENDENT ones first (zero risk, shrink the queue),
 *      then the overlapping ones by fewest overlaps first, then OLDEST first
 *      (longest-blocked ships sooner), then by number for total determinism.
 *   3. Each ready change records which EARLIER-ordered ready changes share a file
 *      with it (rebaseAfter) and the shared files, so the note can be honest about
 *      the cost.
 *
 * `filesByPr` maps a change number to its changed-file paths. A change missing
 * from the map (file list unavailable) is treated as overlapping nothing, and the
 * caller should set `degraded` so the UI flags the analysis as incomplete.
 */
export function planMergeOrder(
  blocking: BlockingChange[],
  filesByPr: Record<number, string[]>,
  opts: { degraded?: { detail: string } } = {},
): MergePlan {
  const ready = blocking.filter((c) => c.state === "ready_to_merge");
  const notReady = blocking.filter((c) => c.state !== "ready_to_merge");

  // Pairwise shared files among READY changes (the ones we actually order).
  const sharedWith = new Map<number, Map<number, string[]>>();
  for (const a of ready) sharedWith.set(a.number, new Map());
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const a = ready[i];
      const b = ready[j];
      const shared = intersect(filesByPr[a.number] ?? [], filesByPr[b.number] ?? []);
      if (shared.length > 0) {
        sharedWith.get(a.number)!.set(b.number, shared);
        sharedWith.get(b.number)!.set(a.number, shared);
      }
    }
  }

  const degree = (n: number) => sharedWith.get(n)?.size ?? 0;

  // Deterministic order: independents (degree 0) first, then by degree asc, then
  // oldest (largest ageHours) first, then number asc.
  const ordered = [...ready].sort((a, b) => {
    const da = degree(a.number);
    const db = degree(b.number);
    if (da !== db) return da - db;
    if (b.ageHours !== a.ageHours) return b.ageHours - a.ageHours;
    return a.number - b.number;
  });

  const placed: number[] = [];
  const steps: MergeStep[] = ordered.map((c, idx) => {
    const peers = sharedWith.get(c.number)!;
    const independent = peers.size === 0;
    // Earlier-ordered ready changes that share a file with this one.
    const rebaseAfter = placed.filter((n) => peers.has(n));
    const sharedFiles = Array.from(
      new Set(rebaseAfter.flatMap((n) => peers.get(n) ?? [])),
    ).sort();
    placed.push(c.number);
    const step = {
      number: c.number,
      title: c.title,
      url: c.url,
      reason: c.reason,
      ready: true,
      order: idx + 1,
      independent,
      rebaseAfter,
      sharedFiles,
    };
    return { ...step, note: buildNote(step) };
  });

  // Non-ready changes are appended (no order) so the operator sees the full queue.
  for (const c of notReady) {
    const step = {
      number: c.number,
      title: c.title,
      url: c.url,
      reason: c.reason,
      ready: false,
      order: null as number | null,
      independent: false,
      rebaseAfter: [] as number[],
      sharedFiles: [] as string[],
    };
    steps.push({ ...step, note: buildNote(step) });
  }

  const hasOverlaps = ready.some((c) => (sharedWith.get(c.number)?.size ?? 0) > 0);
  const independentCount = steps.filter((s) => s.ready && s.independent).length;

  return {
    steps,
    readyCount: ready.length,
    independentCount,
    hasOverlaps,
    ...(opts.degraded ? { degraded: opts.degraded } : {}),
  };
}
