/**
 * A COUNTER MAY NOT CLAIM AN INTERDICTION THE CODE DOES NOT PERFORM.
 *
 * `ai.response_flagged` is written when the router's inspector matches a risky
 * shape in a model answer. The router then DELIVERS that answer: its own
 * comment reads "Recorded rather than blocked", because in a product that
 * writes code for a living a refusal on a false positive costs more trust than
 * an audit row does. That is a deliberate design choice and a defensible one.
 *
 * It was described in two client-facing places as an interception. The model
 * router page headed the column "Unsafe answers stopped, per 1,000" under a
 * subtitle promising "every column is something the product stopped before a
 * person saw it", and the insights dashboard tile read "Answers withheld as
 * unsafe". Both were read by a client as the product blocking unsafe answers.
 *
 * The failure mode is one-directional and quiet: nobody files a bug because a
 * dashboard flatters the product. So it is asserted here instead.
 *
 * This guards the WORDING against the BEHAVIOUR. If the router ever does start
 * withholding flagged answers, this test should be changed in the same commit
 * that changes the router, and not before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Verbs that promise the answer did not reach a person. */
const INTERDICTION = /\b(withheld|withhold|blocked|stopped|prevented|refused|intercepted|suppressed)\b/i;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("flagged answers are never described as withheld", () => {
  it("the router still only records them, which is what makes this test necessary", () => {
    const router = read("src/lib/ai/router.ts");
    /* If this fails, the router changed. Read it before touching the copy. */
    expect(router).toMatch(/Recorded rather than blocked/);
  });

  it("the insights tile does not claim the answer was withheld", () => {
    const page = read("src/app/(dashboard)/admin/insights/page.tsx");
    const tile = page.match(/\["capability-flagged",\s*"([^"]+)"/);
    expect(tile).not.toBeNull();
    expect(tile![1]).not.toMatch(INTERDICTION);
  });

  it("the snapshot detail does not claim the answer was withheld", () => {
    const snapshot = read("src/lib/insights/capability-snapshot.ts");
    /* The two sentences the tile renders, zero and non-zero, taken from the
       ternary itself rather than from a slice of the file: the surrounding
       comment quotes the old wording on purpose. */
    const detail = snapshot.match(
      /detail:\s*flagged === 0\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/,
    );
    expect(detail).not.toBeNull();
    expect(detail![1]).not.toMatch(INTERDICTION);
    expect(detail![2]).not.toMatch(INTERDICTION);
  });

  it("the router quality panel does not claim the answer was stopped", () => {
    const quality = read("src/lib/learning/answer-quality.ts");
    /* The label and the four readings that render for the flagged signal.
       The prose above them documents the old wording on purpose, so only the
       strings inside the flagged entry are checked. */
    const entry = quality.slice(
      /* The trailing comma anchors on the SIGNALS entry rather than on the
         "flagged" | "reviewed" | ... union in the type above it. */
      quality.indexOf('key: "flagged",'),
      quality.indexOf('key: "reviewed",'),
    );
    const strings = [...entry.matchAll(/"([^"]{15,})"/g)].map((m) => m[1]);
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) expect(s).not.toMatch(INTERDICTION);
  });
});
