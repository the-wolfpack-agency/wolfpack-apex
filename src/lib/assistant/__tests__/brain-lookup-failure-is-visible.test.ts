/**
 * A Brain lookup that THREW must not look like a Brain lookup that found
 * nothing.
 *
 * tryBrain's catch was bare. Anything failing inside queryBrain came back as an
 * empty context, and gateUngroundedClaimAboutUs reads that as "nothing was
 * retrieved" and rejects the answer as ungrounded. So a broken retrieval and an
 * empty corpus produced the same sentence for the reader and the same silence
 * for us.
 *
 * Measured against the deployed URL 2026-08-29:
 *
 *   brain_query_log  "how much do we owe upfront?"  ->  4 hits
 *   quality gate     same question                  ->  hit_count 0
 *
 * Both true at once. Four hypotheses died against that gap: the semantic score
 * floor, the query phrasing, whether semantic was running, and an unguarded
 * analytics write. Each was plausible, each was measured, and none was it.
 *
 * Source-level for the same reason as the queryBrain guard: nothing here stands
 * up assistant.ts's module graph, and the property is about a catch block.
 */
import { readFileSync } from "node:fs";

const SOURCE = readFileSync("src/lib/assistant.ts", "utf8");

function tryBrainBody(): string {
  const start = SOURCE.indexOf("async function tryBrain(");
  expect(start).toBeGreaterThan(-1);
  /* To the next top-level declaration, NOT to the first line-start brace.
     tryBrain's return type is a multi-line object literal whose closing line
     begins "}> {", so searching for "\n}" stopped at the signature and handed
     every assertion below an empty body. Five tests failed on a change that
     touched none of what they check. */
  const rest = SOURCE.slice(start + 1);
  const nextDecl = rest.search(/\n(?:export )?(?:async )?function /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe("tryBrain reports why it came back empty", () => {
  /* THE REGRESSION. A bare catch here is what made four different bugs look
     identical, and the next one would too. */
  it("has no silent catch", () => {
    expect(tryBrainBody()).not.toMatch(/\}\s*catch\s*\{\s*\n\s*return \{ strong: null/);
  });

  it("records an event naming the failure", () => {
    const body = tryBrainBody();
    expect(body).toContain("assistant.brain_lookup_failed");
    expect(body).toMatch(/error_name/);
  });

  /* The question is what somebody needs to reproduce it. Without it the event
     says a lookup failed and cannot say for what. */
  it("records what was asked", () => {
    expect(tryBrainBody()).toMatch(/message_text/);
  });

  /* Still non-fatal. Making the failure visible must not make it fatal: a
     Brain that is down should cost grounding, not the whole turn. */
  it("still returns an empty context rather than throwing", () => {
    expect(tryBrainBody()).toMatch(/return \{ strong: null, context: emptyContext \}/);
  });

  /* The event has to be registered or trackEvent will not type-check, and a
     silent drop here would recreate the blind spot in a new place. */
  it("registers the event type", () => {
    const analytics = readFileSync("src/lib/analytics.ts", "utf8");
    expect(analytics).toContain('"assistant.brain_lookup_failed"');
  });
});

/**
 * What tryBrain RECEIVED, as distinct from what queryBrain logged.
 *
 * Measured against the deployed URL 2026-08-29, one turn, no exception:
 *
 *   20:13:22.744  brain_query_log   "when do we have to pay?"  ->  5 hits
 *   20:13:23.446  intent_unmatched  same question              ->  has_brain_context false
 *
 * queryBrain logs hitChunkIds.length and returns that same array, the loop
 * building the context cannot turn five hits into none, and nothing threw.
 * Each is verified; together they are impossible, so one is not what it
 * appears. The number nobody had seen is what this function received.
 */
describe("tryBrain records what it received", () => {
  it("emits the returned hit count before deciding anything", () => {
    const body = tryBrainBody();
    expect(body).toContain("assistant.brain_lookup_returned");
    expect(body).toMatch(/returned_hits/);
    /* Before the early return, or a zero-hit lookup records nothing and the
       case being chased is exactly the zero-hit one. */
    const emitAt = body.indexOf("assistant.brain_lookup_returned");
    const earlyReturnAt = body.indexOf("if (result.hits.length === 0)");
    expect(emitAt).toBeGreaterThan(-1);
    expect(earlyReturnAt).toBeGreaterThan(emitAt);
  });

  it("carries the query log id so the records can be joined", () => {
    expect(tryBrainBody()).toMatch(/query_log_id/);
  });

  it("registers the event type", () => {
    const analytics = readFileSync("src/lib/analytics.ts", "utf8");
    expect(analytics).toContain('"assistant.brain_lookup_returned"');
  });
});
