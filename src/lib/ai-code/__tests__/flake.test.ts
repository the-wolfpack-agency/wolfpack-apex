/**
 * The flake pre-filter picks failing runs still on their first attempt (candidates
 * to re-run once). A run already re-run (attempt >= 2) is a confirmed real failure,
 * not a re-run candidate.
 */
import { flakeRecheckCandidates } from "@/lib/ai-code/flake";

const run = (id: number, name: string, conclusion: string | null, runAttempt: number) => ({ id, name, conclusion, runAttempt });

it("picks failing first-attempt runs, scoped to introduced when given", () => {
  const runs = [
    run(1, "agenticqa-full-pipeline", "failure", 1),
    run(2, "e2e", "failure", 1),        // pre-existing, not introduced
    run(3, "unit", "success", 1),
  ];
  expect(flakeRecheckCandidates(runs, ["agenticqa-full-pipeline"])).toEqual([1]);
});

it("excludes runs already re-run (attempt >= 2 = confirmed real failure)", () => {
  const runs = [run(1, "unit", "failure", 2), run(2, "lint", "failure", 1)];
  expect(flakeRecheckCandidates(runs)).toEqual([2]);
});

it("empty when nothing is failing on a first attempt", () => {
  expect(flakeRecheckCandidates([run(1, "unit", "success", 1)])).toEqual([]);
});
