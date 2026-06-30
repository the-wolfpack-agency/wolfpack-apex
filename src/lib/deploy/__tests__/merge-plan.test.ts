/**
 * Unit tests for the merge-order planner. Pure, no network. Proves the planner
 * produces a deterministic, conflict-aware promotion order with honest notes:
 *  - independent changes flagged safe-any-order;
 *  - overlapping changes ordered, with the later one told to rebase after the
 *    earlier one and on which files (append-only hot files get the "union" note);
 *  - non-ready changes listed with order=null and a "resolve first" note;
 *  - deterministic ordering (independents first, then degree, then oldest);
 *  - degraded passthrough so the UI can flag incomplete analysis.
 */

import { planMergeOrder, APPEND_ONLY_HOT_FILES } from "../merge-plan";
import type { BlockingChange, ReleaseBlockState } from "../release-gate";

function change(number: number, state: ReleaseBlockState, ageHours = 1, reason = "Ready to promote"): BlockingChange {
  return { number, title: `Change ${number}`, url: `https://gh/pr/${number}`, author: "dev", headSha: `sha${number}`, state, reason, ageHours };
}

const READY: ReleaseBlockState = "ready_to_merge";

test("disjoint ready changes are all independent and order-free", () => {
  const plan = planMergeOrder([change(1, READY), change(2, READY)], { 1: ["src/a.ts"], 2: ["src/b.ts"] });
  expect(plan.readyCount).toBe(2);
  expect(plan.independentCount).toBe(2);
  expect(plan.hasOverlaps).toBe(false);
  for (const s of plan.steps) {
    expect(s.independent).toBe(true);
    expect(s.rebaseAfter).toEqual([]);
    expect(s.note).toMatch(/independent/i);
  }
});

test("two changes sharing an append-only hot file are ordered with a union-rebase note", () => {
  const hot = "src/lib/analytics.ts";
  expect(APPEND_ONLY_HOT_FILES).toContain(hot);
  const plan = planMergeOrder([change(1, READY), change(2, READY)], { 1: [hot, "src/x.ts"], 2: [hot, "src/y.ts"] });

  expect(plan.hasOverlaps).toBe(true);
  expect(plan.independentCount).toBe(0);
  const ordered = plan.steps.filter((s) => s.ready);
  expect(ordered.map((s) => s.order)).toEqual([1, 2]);

  const first = ordered[0];
  const second = ordered[1];
  expect(first.rebaseAfter).toEqual([]);
  expect(first.note).toMatch(/first of its overlapping group/i);
  expect(second.rebaseAfter).toEqual([first.number]);
  expect(second.sharedFiles).toContain(hot);
  expect(second.note).toMatch(/union/i);
});

test("a non-hot shared file gets a re-check note, not a union note", () => {
  const plan = planMergeOrder([change(1, READY), change(2, READY)], { 1: ["src/feature.ts"], 2: ["src/feature.ts"] });
  const second = plan.steps.filter((s) => s.ready)[1];
  expect(second.sharedFiles).toEqual(["src/feature.ts"]);
  expect(second.note).toMatch(/rebase and re-check/i);
  expect(second.note).not.toMatch(/union/i);
});

test("non-ready changes are listed with no order and a resolve-first note", () => {
  const plan = planMergeOrder(
    [change(1, READY), change(2, "merge_conflict", 3, "Has merge conflicts")],
    { 1: ["src/a.ts"] },
  );
  const blocked = plan.steps.find((s) => s.number === 2)!;
  expect(blocked.ready).toBe(false);
  expect(blocked.order).toBeNull();
  expect(blocked.note).toMatch(/resolve first/i);
  // The ready one still gets order 1.
  expect(plan.steps.find((s) => s.number === 1)!.order).toBe(1);
});

test("ordering is deterministic: independents first, then by overlap degree, then oldest", () => {
  // 1 overlaps 2 and 3 (degree 2); 2 overlaps 1; 3 overlaps 1; 4 independent.
  // Expected: independent (4) first, then the degree-1 nodes oldest-first (2 is
  // older than 3), then the degree-2 node (1).
  // #1 shares a DIFFERENT file with each of #2 and #3 (so #2 and #3 do not
  // overlap each other): #1 = degree 2, #2/#3 = degree 1, #4 independent.
  const plan = planMergeOrder(
    [change(1, READY, 5), change(2, READY, 9), change(3, READY, 2), change(4, READY, 1)],
    { 1: ["f2.ts", "f3.ts"], 2: ["f2.ts"], 3: ["f3.ts"], 4: ["solo.ts"] },
  );
  const order = plan.steps.filter((s) => s.ready).sort((a, b) => a.order! - b.order!).map((s) => s.number);
  expect(order).toEqual([4, 2, 3, 1]);
});

test("degraded analysis is passed through and the order is still produced", () => {
  const plan = planMergeOrder([change(1, READY), change(2, READY)], { 1: ["src/a.ts"] }, { degraded: { detail: "files unavailable" } });
  expect(plan.degraded?.detail).toBe("files unavailable");
  // Missing file list -> treated as overlapping nothing, still ordered.
  expect(plan.steps.filter((s) => s.ready).map((s) => s.order)).toEqual([1, 2]);
});
