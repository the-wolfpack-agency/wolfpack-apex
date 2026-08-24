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
  /* The other side of widening the capability matcher. Each of these
     carries an OBJECT, which is the whole discriminator: asking what the
     assistant can help with is asking for the menu, asking what it can
     help with ON THE ACKERMAN CLAIM is asking about a claim. A capability
     tool that swallowed these would answer confidently and never say it
     was unsure, which is a worse failure than the one it fixed. */
  ["what can you help me with on the Ackerman claim?", "capability phrasing, real object"],
  ["how can you help me fix this invoice", "capability phrasing, real object"],
  ["can you help me with the warranty claim", "capability phrasing, real object"],
  ["what do you do about a rejected claim?", "capability phrasing, real object"],
  ["where do I start the claim from?", "capability phrasing, real object"],
  ["what should I ask the technician?", "capability phrasing, real object"],
  /* Running a chain is not asking which chains exist. The catalogue must
     not answer for the runner, or "run my morning" becomes a menu. */
  ["run my morning", "starts a chain, does not list them"],
  ["start my day", "starts a chain, does not list them"],
  /* "can you see" is also an idiom. Somebody checking they have been
     understood is not asking what this is plugged into, and the tell is
     that a question word follows the verb rather than a system. */
  ["can you see what I mean", "an idiom, not a connectivity question"],
  ["can you see if the invoice went out", "a lookup, not a connectivity question"],
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
  /* THE FIRST THING ANYBODY TYPES.
     "what can you do?" worked and "what can you actually do for me
     today?" spent 1,483 tokens to say it had no confident answer. Five of
     ten ordinary phrasings missed, including the two commonest. It is the
     worst question to fail: the answer to it is the only thing standing
     between a new user and giving up. */
  ["what can you do?", ["what_can_you_do"]],
  ["what can you actually do for me today?", ["what_can_you_do"]],
  ["what can you help me with?", ["what_can_you_do"]],
  ["how can you help?", ["what_can_you_do"]],
  ["what should I ask you?", ["what_can_you_do"]],
  ["where do I start?", ["what_can_you_do"]],
  ["what are you able to do", ["what_can_you_do"]],
  ["help", ["what_can_you_do"]],
  /* THE QUESTION THAT OPENS THE CHAINING FEATURE.
     "what routines can I run?" matched nothing on the deployed assistant,
     fell through to a model, and came back describing the inventory sync
     and VIN decode routines of a DIFFERENT product, pulled out of the
     brain with complete confidence. 1,391 tokens to answer the wrong
     question about the wrong system.
     Somebody evaluating whether this can automate their work asks this
     first. "Template" is our word for it; routine, workflow, automation
     and chain are theirs. */
  ["what routines can I run?", ["routine_templates"]],
  ["what automations do you have?", ["routine_templates"]],
  ["what workflows are there", ["routine_templates"]],
  /* Universal search also claims this one, because "show me the ..." is
     a search phrasing. Recorded rather than narrowed: search is
     deliberately broad, and taking that shape away from it to win one
     prompt would cost more than it gains. Registration order decides,
     routine_templates is registered at position 9 against search at 54,
     so the catalogue answers. The point of naming it here is that the
     tie is a decision somebody made rather than one a client discovers. */
  ["show me the routines", ["routine_templates", "search"]],
  ["list my automations", ["routine_templates"]],
  ["what can I automate", ["routine_templates"]],
  /* WHAT AM I CONNECTED TO IS A QUESTION ABOUT REALITY.
     "what tools are you connected to?" was answered from the live
     registry. "do you have access to our CRM?" matched nothing, reached a
     model, and the model answered out of the knowledge base: "Yes, I have
     access to your CRM system integrated into the wolfpack-auto
     platform." Every clause of that is a claim about what THIS product
     can reach, made from a document about a different one.
     A missing capability is a gap. A claimed one that does not exist is
     the thing a client discovers by relying on it. */
  ["do you have access to our CRM?", ["integrations_list_widget"]],
  ["can you see my email?", ["integrations_list_widget"]],
  ["are you connected to Salesforce?", ["integrations_list_widget"]],
  ["do you integrate with HubSpot?", ["integrations_list_widget"]],
];

describe("prompts that must reach the tool built for them", () => {
  it.each(MUST_MATCH)("%s", (prompt, acceptable) => {
    const hits = claimants(prompt);
    expect(
      `${prompt} | ${hits.some((h) => acceptable.includes(h)) ? "reached a tool built for it" : `reached: ${hits.join(", ") || "nothing"}`}`,
    ).toBe(`${prompt} | reached a tool built for it`);
  });
});

describe("no tool answers for a domain it does not cover", () => {
  it("never claims a prompt that belongs to somebody else", () => {
    /* The first version of this counted how many prompts each tool
       claimed and complained past a threshold. That was the wrong
       measure: the capability tool legitimately owns eight phrasings
       BECAUSE THEY ARE ALL THE SAME QUESTION, and a count cannot tell
       that from a catch-all.
       What actually matters is trespass. For every prompt with a known
       owner, any other tool claiming it is answering for a domain it does
       not cover, and that is the failure this corpus exists to catch. */
    const trespass: string[] = [];
    for (const [prompt, acceptable] of MUST_MATCH) {
      for (const name of claimants(prompt)) {
        if (!acceptable.includes(name)) trespass.push(`${name} <- "${prompt}"`);
      }
    }
    expect(trespass).toEqual([]);
  });
});
