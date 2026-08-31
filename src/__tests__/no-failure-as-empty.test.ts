/**
 * A failure must not be spelled the same way as an empty result.
 *
 * THE BUG THIS COUNTS. On 2026-08-30, with the model provider unreachable and
 * the answer sitting in the corpus, the product said "I don't have information
 * on that yet. You can help me learn by adding it to the Knowledge Base."
 * Every clause false. The cause was one line: `catch { return null }`, where
 * null already meant "nothing matched". A failure and an absence were spelled
 * identically, so no code downstream could tell them apart.
 *
 * That shape is not rare. This walks the answer path and counts every catch
 * whose entire body is an empty return with nothing recorded: null, [], "",
 * false, undefined. Each one is a place where an outage can be reported to
 * somebody as "we have nothing on that".
 *
 * IT IS A RATCHET, NOT A BAN. Many of these are genuinely fine: a failed
 * optional lookup that the caller retries another way costs nobody anything,
 * and rewriting forty-six call sites at once would be a large change with no
 * measurement behind it. The number may only fall. Lowering it requires
 * editing this line, in the same commit that earns it.
 *
 * WHAT "FIXED" MEANS for one of these. Not "add a comment". Either record the
 * failure (trackEvent / a degradation collector, so an outage is visible and
 * the reader can be told the truth) or return something that distinguishes a
 * failure from an absence. A comment explains the choice to a reader and does
 * nothing for the person waiting on the answer.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The path that produces an answer. Where confusing the two shapes is felt. */
const ROOTS = ["src/lib/assistant.ts", "src/lib/assistant", "src/lib/brain", "src/lib/search"];

function walk(p: string): string[] {
  const out: string[] = [];
  if (statSync(p).isFile()) return p.endsWith(".ts") ? [p] : [];
  for (const entry of readdirSync(p)) {
    if (entry === "__tests__") continue;
    out.push(...walk(join(p, entry)));
  }
  return out;
}

const CATCH_BLOCK = /catch\s*(?:\([^)]*\))?\s*\{(.*?)\n(\s*)\}/gs;
const EMPTY_RETURN = /^return\s*(null|undefined|\[\]|\{\}|""|''|false|0)?\s*;?$/;
/* Anything that leaves a trace a human or a dashboard could later find. */
const RECORDS_SOMETHING = /trackEvent|console\.|record|logger|obs\.|captureError|report/;

interface Site {
  file: string;
  line: number;
}

function failuresSpelledAsEmpty(): Site[] {
  const sites: Site[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(CATCH_BLOCK)) {
        const body = m[1];
        const code = body.replace(/\/\*.*?\*\//gs, "").replace(/\/\/[^\n]*/g, "");
        const lines = code
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) continue;
        if (!lines.every((l) => EMPTY_RETURN.test(l))) continue;
        if (RECORDS_SOMETHING.test(body)) continue;
        sites.push({ file, line: src.slice(0, m.index).split("\n").length });
      }
    }
  }
  return sites;
}

describe("a failure is not spelled like an empty result", () => {
  /* THE RATCHET. Measured 46 on 2026-08-30, then 45 once the knowledge-base
     lookup was fixed: a Postgres blip there made the knowledge base look
     EMPTY, which cascaded into telling somebody we had nothing on a question
     we hold the answer to. It is the clearest example of why this number
     matters, and it is why the fix and this test arrived together.

     Lower it when you fix one. Never raise it. */
  const CEILING = 45;

  it(`has at most ${CEILING} places where a failure returns an empty result unrecorded`, () => {
    const sites = failuresSpelledAsEmpty();
    const listed = sites.map((s) => `${s.file}:${s.line}`).join("\n");
    expect(
      `${sites.length} sites (ceiling ${CEILING})\n${listed}`.slice(0, 4000),
    ).toContain(`${sites.length} sites`);
    expect(sites.length).toBeLessThanOrEqual(CEILING);
  });

  /* A ratchet nobody tightens is a ratchet that rusts. If the count drops well
     below the ceiling, this asks for the ceiling to come down with it, so the
     guard keeps its grip instead of trailing reality by ten. */
  it("keeps the ceiling close to reality", () => {
    const n = failuresSpelledAsEmpty().length;
    expect(
      `count ${n} vs ceiling ${CEILING}: lower CEILING in this file to ${n}`,
    ).toBe(`count ${n} vs ceiling ${CEILING}: lower CEILING in this file to ${n}`);
    expect(CEILING - n).toBeLessThanOrEqual(5);
  });

  /* The one that caused the incident must stay fixed. It is asserted by
     behavior rather than by line number, which moves. */
  it("the knowledge-base lookup records its failure rather than looking empty", () => {
    const src = readFileSync("src/lib/assistant.ts", "utf8");
    const fn = src.slice(src.indexOf("async function tryKnowledgeBase"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/system\.knowledge_lookup_failed/);
    expect(body).toMatch(/degradation\?\.record/);
  });
});
