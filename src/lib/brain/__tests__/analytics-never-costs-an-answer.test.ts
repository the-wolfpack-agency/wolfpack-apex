/**
 * A failed analytics write must not throw away a retrieval that worked.
 *
 * queryBrain wrapped its query log in try/catch, with the comment "non-blocking
 * — the user still gets their answer", and then awaited two trackEvent calls
 * with no guard at all, a few lines before returning.
 *
 * So when analytics threw, queryBrain threw AFTER the log was written.
 * tryBrain caught it and returned its empty context, and
 * gateUngroundedClaimAboutUs reads hitCount as the only input deciding whether
 * an answer is grounded.
 *
 * Measured against the deployed URL 2026-08-29:
 *
 *   brain_query_log  "how much do we owe upfront?"  ->  4 hits
 *   quality gate     same question, same second     ->  hit_count 0,
 *                    "asked about this organization with no retrieved source
 *                     to answer", verdict reject
 *   the person       ->  "I don't have a confident answer for that."
 *
 * Both records were true. The hits were found, logged, then discarded by an
 * exception a few lines later. It presents as a relevance problem, which is why
 * it survived three wrong hypotheses about thresholds, phrasing and routing.
 * Retrieval worked every time.
 *
 * WHY THIS IS A SOURCE TEST. Nothing in the repo exercises the real queryBrain:
 * brain-routes.test.ts mocks the module wholesale, and standing its graph up
 * pulls in the pg pool, Qdrant and the embedder for a claim that is purely
 * about control flow around an await. The property worth protecting is stated
 * directly instead, the same way the app-shell heights and the channel-scan
 * bounds are.
 */
import { readFileSync } from "node:fs";

const SOURCE = readFileSync("src/lib/brain/query.ts", "utf8");

describe("queryBrain does not let analytics discard a retrieval", () => {
  /* THE REGRESSION ITSELF. An awaited trackEvent between computing hits and
     returning them is the exact shape that caused this.
     Scoped to queryBrain: markCited awaits trackEvent too, and that one is
     correct because it sits inside a try/catch already marked "audit-loop
     writes are never fatal". A blunter check flagged it, which is the right
     instinct and the wrong target. */
  it("never awaits trackEvent bare inside queryBrain", () => {
    const start = SOURCE.indexOf("export async function queryBrain");
    const end = SOURCE.indexOf("export async function markCited");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(SOURCE.slice(start, end)).not.toMatch(/await trackEvent\(/);
  });

  it("routes every trackEvent through a catch", () => {
    /* Every mention of trackEvent that is not the import or a comment should
       sit inside the guarded block. */
    const guarded = /void Promise\.resolve\([\s\S]{0,80}\)\.catch\(/.test(SOURCE);
    expect(guarded).toBe(true);
  });

  /* The log write directly above was ALWAYS guarded. These are the same kind
     of write and the two must not drift apart again, which is how one ended up
     protected and the other not. */
  it("keeps the query-log write guarded too", () => {
    const logBlock = SOURCE.slice(SOURCE.indexOf("logQuery({"));
    expect(logBlock.slice(0, 600)).toMatch(/\}\s*catch\s*\{/);
  });

  /* Both outcomes still get recorded: the fix is about not throwing, not about
     recording less. */
  it("still records a hit and a miss", () => {
    expect(SOURCE).toContain('"brain.query_hit"');
    expect(SOURCE).toContain('"brain.query_miss"');
  });
});
