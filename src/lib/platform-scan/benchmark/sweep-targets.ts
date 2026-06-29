/**
 * Pure target-selection helper for the continuous benchmark sweep.
 *
 * The sweep CLI (scripts/benchmark-sweep.mjs) is a THIN orchestrator: it supplies
 * the real browser and the network, while the decision of WHICH targets are
 * sweepable - and the safety assertion that gates them - lives here, so it can be
 * unit-tested without a browser or network.
 *
 * SAFETY: this helper enforces the read-only consent floor of the sweep. It returns
 * ONLY corpus targets that pass `assertBenchmarkConsent(target, "read-only")`. The
 * sweep is read-only ALWAYS; active recall (probing planted vulns on a self-hosted
 * fixture) is a separate authorized pentest run, never this path. A non-corpus
 * entry can never reach this list because `BENCHMARK_CORPUS` is the only input and
 * the consent gate throws for anything outside it.
 */

import {
  BENCHMARK_CORPUS,
  assertBenchmarkConsent,
  type BenchmarkTarget,
} from "./corpus";

/**
 * Default route set swept per target when an entry carries no explicit list. The
 * sweep is a posture/health pass over the surfaces every web app exposes, so these
 * are the generic public entry points; each is read-only (GET/HEAD only, enforced
 * by the read-only floor the runner installs on every page).
 */
export const DEFAULT_SWEEP_ROUTES: { path: string; journey: string }[] = [
  { path: "/", journey: "landing" },
  { path: "/login", journey: "login" },
];

/**
 * The outcome of selecting sweep targets: the ones that pass the read-only consent
 * gate, plus any that were skipped (with a coarse reason) so a refused target is
 * observable rather than silently dropped.
 */
export interface SweepSelection {
  selected: BenchmarkTarget[];
  skipped: { name: string; reason: string }[];
}

/**
 * Select the targets the continuous sweep may scan, READ-ONLY. Every candidate is
 * gated through `assertBenchmarkConsent(target, "read-only")`; a target that throws
 * (e.g. somehow not in the corpus) is skipped with its coarse reason, never scanned.
 * Defaults to the full `BENCHMARK_CORPUS`; a caller may pass a subset (still gated).
 */
export function selectReadOnlyTargets(
  corpus: readonly BenchmarkTarget[] = BENCHMARK_CORPUS,
): SweepSelection {
  const selected: BenchmarkTarget[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const target of corpus) {
    try {
      // The safety floor: read-only consent must hold for EVERY swept target.
      assertBenchmarkConsent(target, "read-only");
      selected.push(target);
    } catch (err) {
      const reason =
        err && typeof err === "object" && "reason" in err
          ? String((err as { reason: unknown }).reason)
          : "consent_refused";
      skipped.push({ name: target?.name ?? "(unknown)", reason });
    }
  }

  return { selected, skipped };
}
