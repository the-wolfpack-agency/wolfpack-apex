/**
 * DOGFOOD PROOF (temporary - delete after). A deliberately-broken, hand-authored
 * change labeled `ci-autofix`, to watch the autonomous loop fix AND (if enabled)
 * auto-merge it end to end with no human in the path. The return below is a type
 * error the loop should repair to `a + b`; the paired test is what makes the fixed
 * change auto-merge-ELIGIBLE (small, non-sensitive, tests present, gate allow).
 */
export function dogfoodAdd(a: number, b: number): number {
  return a + b;
}