/**
 * The things a client actually types.
 *
 * Every tool decides for itself whether a message is for it, and nothing
 * checks those decisions against each other. That is how "I look after
 * warranty claims for three dealerships" reached the financials tool:
 * "arr" is inside w-arr-anty, the hint list matched on substrings, and
 * the person was told they lacked the privilege for a tool they never
 * asked for.
 *
 * A wrong tool with a confident voice is worse than no tool. "I cannot
 * answer that yet" is a sentence somebody can work with; an authorisation
 * error about financials, in answer to a question about warranty work,
 * teaches them the product does not understand their job.
 *
 * So this is a corpus, and it grows. Every prompt here was written as
 * somebody at a dealership or an agency would type it, and each one
 * declares which tools may legitimately claim it. Adding a prompt is how
 * a new phrasing gets defended; adding a tool means answering to every
 * prompt already here.
 */

export {};

import "../index";
import { getTools } from "../registry";

function claimants(message: string): string[] {
  const out: string[] = [];
  for (const tool of getTools() as unknown as Array<{
    name: string;
    matchIntent?: (m: string) => unknown;
  }>) {
    try {
      if (tool.matchIntent && tool.matchIntent(message)) out.push(tool.name);
    } catch {
      /* A matcher that throws is its own bug and has its own test. */
    }
  }
  return out;
}

/**
 * Prompts that no tool should claim.
 *
 * Not because we would never want to answer them, but because no tool
 * here answers them TODAY, and the honest path is the model or an "I
 * don't know" rather than a tool that fires on one stray word.
 */
const MUST_NOT_MATCH: Array<[string, string]> = [
  ["I look after warranty claims for three dealerships. what would you do first?",
   "the report that started this: arr inside warranty"],
  ["how do I submit a warranty claim?", "warranty again, framed as a question"],
  ["which claims are still waiting on the manufacturer?", "claims work, no tool for it yet"],
  ["the carrier rejected the claim, what now?", "carrier also contains arr"],
  ["we are in arrears on two accounts", "arrears contains arr, and this is a statement"],
  ["what did the technician write on the repair order?", "service work, no tool yet"],
  ["my customer is angry about a delay, what do I say?", "advice, not a lookup"],
  ["the car arrived damaged, who do I tell?", "arrived contains arr"],
];

describe("prompts a dealership types that no tool should claim", () => {
  it.each(MUST_NOT_MATCH)("%s", (prompt, why) => {
    const hits = claimants(prompt);
    /* `why` names the trap each prompt is guarding. */
    expect(`${why} | claimed by: ${hits.join(", ") || "nothing"}`).toBe(
      `${why} | claimed by: nothing`,
    );
  });
});

/**
 * Prompts that MUST reach a specific tool.
 *
 * The other half of the same guarantee. Narrowing a matcher to kill a
 * false positive is easy and it is how the real capability quietly
 * disappears, so every fix has to keep these lit.
 */
const MUST_MATCH: Array<[string, string[]]> = [
  ["what was our revenue last quarter?", ["get_financials_metric"]],
  ["how much did we spend on cloud this month?", ["get_financials_metric"]],
  ["what is our ARR?", ["get_financials_metric"]],
  ["what are our costs year to date?", ["get_financials_metric"]],
  /* Either calendar tool is defensible here and the availability one wins
     today. Worth a note rather than a silent pass: asked what is ON their
     calendar, somebody wants the list, and availability answers whether
     they are free. On an empty week those are the same sentence, which is
     exactly why nobody has noticed. Recorded as an alternative rather
     than asserted as correct. */
  ["what is on my calendar this week?", ["calendar_widget", "get_calendar_availability"]],
  ["analyse my calendar", ["schedule_health"]],
  ["what are my ideal times of day?", ["schedule_health"]],
  ["compare contacts across systems", ["compare_across_sources"]],
  ["what is in the legacy database that nobody uses?", ["dark_data"]],
];

describe("prompts that must reach the tool built for them", () => {
  it.each(MUST_MATCH)("%s", (prompt, acceptable) => {
    const hits = claimants(prompt);
    expect(
      `${prompt} | ${hits.some((h) => acceptable.includes(h)) ? "reached a tool built for it" : `reached: ${hits.join(", ") || "nothing"}`}`,
    ).toBe(`${prompt} | reached a tool built for it`);
  });
});

describe("no tool answers for a whole domain it does not cover", () => {
  it("does not let one tool claim more than a couple of these at once", () => {
    /* A matcher broad enough to claim most of a corpus is not a matcher,
       it is a catch-all, and a catch-all is how a confident wrong answer
       gets delivered. Counted across the prompts that SHOULD land
       somewhere, since a tool legitimately owning its own domain is the
       point. */
    const counts = new Map<string, number>();
    for (const [prompt] of MUST_MATCH) {
      for (const name of claimants(prompt)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const greedy = [...counts.entries()].filter(([, n]) => n > 4);
    expect(greedy.map(([n, c]) => `${n} claims ${c}`)).toEqual([]);
  });
});
