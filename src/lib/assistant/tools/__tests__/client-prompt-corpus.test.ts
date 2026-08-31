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
 * answer that yet" is a sentence somebody can work with; an authorization
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
  /* Widening feedback and the feature form put these in reach. A broken
     car is not a broken page, and a client wanting to cancel is not a
     feature request. */
  ["the car is broken", "a vehicle, not the software"],
  ["the client wants to cancel", "a cancellation, not a request"],
  /* "Spend" is also a word about time. Money has an amount or a period
     attached; a day is not either. */
  ["how should I spend today", "spending time, not money"],
  /* Identical grammar to a bug report and not one. The UI noun is what
     separates them: icons and attachments are ours, dealers and clients
     are not. */
  ["the dealer doesnt want the car", "a business fact, not a bug"],
  ["the client cannot attend friday", "a business fact, not a bug"],
  ["the car isnt ready", "a business fact, not a bug"],
  /* Widening the diary matcher put these in reach. Booking a car in for a
     service and blocking somebody from a portal are not calendar
     entries, and neither is a question about billed hours. */
  ["book the car in for a service", "a service booking, not a diary entry"],
  ["block the dealer from the portal", "an access change, not a diary entry"],
  /* A bare noun is a command only when it is the whole message. This one
     started with the word "receipt" and opened a scanning form, which was
     a pre-existing over-reach the sweep surfaced. */
  ["receipt of the goods was confirmed", "prose that begins with a command word"],
  /* Widening the task matcher put these within reach. "remind the dealer"
     is somebody ELSE being reminded, and "a note OF the mileage" is a
     record rather than a thing to do. */
  ["remind the dealer to call us", "somebody else being reminded"],
  ["make a note of the mileage", "a record, not a task"],
  /* The discriminator for a message is WHO is being told. These point the
     other way: somebody asking to BE told. A compose form in answer to a
     question is the trespass to avoid. */
  ["let me know if that works", "asking to be told"],
  ["let us know the outcome", "asking to be told"],
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
  /* Running a chain is not asking which chains exist. The catalog must
     not answer for the runner, or "run my morning" becomes a menu. */
  ["run my morning", "starts a chain, does not list them"],
  ["start my day", "starts a chain, does not list them"],
  /* "can you see" is also an idiom. Somebody checking they have been
     understood is not asking what this is plugged into, and the tell is
     that a question word follows the verb rather than a system. */
  ["can you see what I mean", "an idiom, not a connectivity question"],
  ["can you see if the invoice went out", "a lookup, not a connectivity question"],
  /* Widening the task and meeting matchers put these within reach, and
     each carries an OBJECT that makes it a different question. A task
     list answering "what do I owe the dealer group" would be trespassing
     the same way the financials tool did on warranty. */
  ["what do I owe the dealer group", "money owed to a party, not a task list"],
  ["anything overdue on the invoice", "about an invoice, not a task list"],
  ["what is waiting on the supplier", "about a supplier, not a task list"],
  ["brief me on the Q3 numbers", "a briefing, not a meeting"],
  ["get me ready for the audit", "an audit, not a meeting"],
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
  ["analyze my calendar", ["schedule_health"]],
  ["what are my ideal times of day?", ["schedule_health"]],
  /* Questions about the SHAPE of a week, which is the line between this
     and the calendar tools. Also from the sweep. */
  ["how much of my week is meetings", ["schedule_health"]],
  ["which hours should I protect", ["schedule_health"]],
  ["when am I most free", ["schedule_health"]],
  /* The two most-asked questions at a desk, both of which reached no tool
     at all until they were swept. Every phrasing here was being paid for
     as a model call and answered from a document. */
  ["what is waiting on me", ["task_list_widget"]],
  ["what is on my plate", ["task_list_widget"]],
  ["anything overdue", ["task_list_widget"]],
  ["my open tasks", ["task_list_widget"]],
  ["what came in overnight", ["email_thread_widget"]],
  /* Taken from the production backlog rather than guessed. Every one was
     filed as an unanswered question and answered by a model, which
     listened and recorded nothing. Nobody writes "I have feedback": they
     describe the thing that did not happen. */
  ["the ai agent widget icon doesnt appear on messages", ["feedback"]],
  ["this attachment wont send unless i type into the field", ["feedback"]],
  ["the export isnt working", ["feedback"]],
  ["check my inbox", ["email_thread_widget"]],
  ["any new email", ["email_thread_widget"]],
  /* Three tools that were command-shaped and unreachable by any natural
     phrasing: every one of these has a word between the verb and the
     noun, or puts an amount where the noun was. The command forms still
     work, so nobody who learned them loses anything. */
  ["scan this invoice", ["scan_invoice"]],
  ["what does this invoice say", ["scan_invoice"]],
  ["scan this receipt", ["scan_receipt"]],
  ["expense this", ["scan_receipt"]],
  ["log 2 hours on the recall job", ["log_time"]],
  ["record 90 minutes on the handover", ["log_time"]],
  ["log my time for today", ["log_time"]],
  /* The moment somebody says it is broken is the moment to catch it. All
     of these reached a model, which listened and recorded nothing, and
     "report a bug" went to the GitHub issue SEARCH, so somebody
     reporting a fault was shown a list of other people's. */
  ["this is broken", ["feedback"]],
  ["report a bug", ["feedback"]],
  ["something is not working", ["feedback"]],
  ["this page is wrong", ["feedback"]],
  /* How a request actually arrives: somebody repeating what they were
     just told. Otherwise it stays in a mailbox. */
  ["the client wants a new report", ["create_feature_form"]],
  ["log a feature request", ["create_feature_form"]],
  ["raise a feature request for bulk upload", ["create_feature_form"]],
  /* Telling somebody something rarely uses the word "message". All five
     ordinary phrasings reached a model, which cannot send anything, so
     the person got a paragraph about how they might word it instead of a
     draft with a send button and a confirmation step. */
  ["tell the team it is ready for review", ["create_message_form"]],
  ["let the dealer know the part arrived", ["create_message_form"]],
  ["send a note to Dana about the delay", ["create_message_form"]],
  ["post to the channel that we are live", ["create_message_form"]],
  /* Pinned here rather than as a must-not-match because org facts
     legitimately answers it: it is a question ABOUT an account. What must
     never happen is a compose form appearing in answer to a question, and
     the trespass check enforces exactly that. */
  ["tell me about the Ackerman account", ["get_org_facts"]],
  /* Putting something in the diary without saying "meeting". What these
     have instead of a noun is a DURATION, which is what somebody says
     when the point is the time rather than the occasion. */
  ["book me 30 minutes with Dana tomorrow", ["create_calendar_event_form"]],
  ["block an hour tomorrow morning", ["create_calendar_event_form"]],
  ["put a hold in for the handover", ["create_calendar_event_form"]],
  ["what is happening across my tools", ["cross_tool_insights_widget"]],
  ["what patterns do you see", ["cross_tool_insights_widget"]],
  ["brief me on my 10am", ["meeting_prep"]],
  ["get me ready for the meeting", ["meeting_prep"]],
  ["what do I need to know before this call", ["meeting_prep"]],
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
  /* Found by sweeping the phrasings rather than by waiting for somebody
     to type them. A leading "so" is how a person carries on a
     conversation, and it made this miss a matcher that already knew
     "what do you do". */
  ["so what do you actually do", ["what_can_you_do"]],
  ["what else can you do", ["what_can_you_do"]],
  ["give me the tour", ["what_can_you_do"]],
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
     so the catalog answers. The point of naming it here is that the
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
