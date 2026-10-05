/**
 * DOGFOOD PROOF (temporary): a deliberately-broken, hand-authored file to prove the
 * ci-autofix loop repairs a labeled PR end to end - with no human in the path.
 *
 * The PR carrying this file is labeled `ci-autofix`, so the autonomous watcher
 * (which otherwise acts only on factory/* branches) is allowed to triage it: it
 * should classify the type error below as a mechanical failure, author a gated fix,
 * push it, and turn CI green. A human then just approves/closes.
 *
 * Safe: imported nowhere (only breaks tsc), and the loop never auto-merges.
 */
export const ciAutofixProof: number = "this value is a string, which is a type error the loop should fix";
