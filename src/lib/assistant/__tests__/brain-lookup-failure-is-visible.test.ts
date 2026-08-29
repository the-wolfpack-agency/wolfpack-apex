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
  /* To the end of the function, which is the first line-start brace after it. */
  const end = SOURCE.indexOf("\n}", start);
  return SOURCE.slice(start, end);
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
