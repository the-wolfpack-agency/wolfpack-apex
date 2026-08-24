/**
 * Every way somebody might ask for something we can already do.
 *
 * The live conversation probe finds bugs by talking to a deployment. It
 * is the honest check and it is slow: a network round trip a turn, real
 * tokens, and one gap found per conversation.
 *
 * Almost every gap it has found was a MATCHER gap, and matchers are pure
 * functions. So they can be swept: hundreds of phrasings, locally, in a
 * second, for nothing. "arr" inside "warranty", "what routines can I
 * run", "do you have access to our CRM" and "show me what you can
 * automate" were all found one at a time by conversation. This finds that
 * whole class at once.
 *
 * WHAT A MISS MEANS. Not that the product is broken. A phrasing that
 * reaches no tool falls to a model, which answers from whatever is
 * nearest in the knowledge base, and that has been another product's
 * documentation more than once. So a miss is a question we answer
 * expensively and unreliably when we could answer it deterministically
 * and correctly.
 *
 * Usage:  npx tsx scripts/phrase-sweep.ts
 *         npx tsx scripts/phrase-sweep.ts --misses-only
 */

import "@/lib/assistant/tools/index";
import { getTools } from "@/lib/assistant/tools/registry";

interface Capability {
  /** The tool that should answer, or null when nothing should. */
  tool: string | null;
  what: string;
  phrasings: string[];
}

/* Written as somebody speaks, not as a spec. Contractions, missing
   punctuation, leading filler and trailing politeness are all how the
   question actually arrives. */
const CAPABILITIES: Capability[] = [
  {
    tool: "what_can_you_do",
    what: "what this thing does",
    phrasings: [
      "what can you do", "what can you do?", "what can you help me with",
      "how can you help", "how can you help me", "what are you able to do",
      "what do you do", "what should I ask you", "where do I start",
      "help", "what can you actually do for me today",
      "so what do you actually do", "give me the tour",
      /* "what are my options" is deliberately absent. In a product that
         also holds deals and quotes it is at least as likely to be a
         question about a customer's choices, and a capability tool that
         answered it would be trespassing on a real question. Left to the
         model on purpose. */
      "what else can you do",
    ],
  },
  {
    tool: "routine_templates",
    what: "what can be automated",
    phrasings: [
      "what can I automate", "what could I automate", "what routines can I run",
      "what workflows are there", "what automations do you have",
      "show me the routines", "list my automations", "show me what you can automate",
      "what chains can I run", "routine templates", "workflow templates",
      "what can you automate for me", "do you have any prebuilt workflows",
      "what automations are available",
    ],
  },
  {
    tool: "integrations_list_widget",
    what: "what it is connected to",
    phrasings: [
      "what tools are you connected to", "what integrations do we have",
      "do you have access to our CRM", "can you see my email",
      "are you connected to Salesforce", "do you integrate with HubSpot",
      "can you read my mail", "do you have access to my calendar",
      "what are you connected to", "what systems can you see",
      "which integrations are set up", "are you hooked up to our DMS",
    ],
  },
  {
    tool: "schedule_health",
    what: "the shape of somebody's week",
    phrasings: [
      "analyse my calendar", "analyze my calendar", "review my schedule",
      "what are my ideal times of day", "when should I do focus work",
      "where is my week going", "schedule health",
      "how much focus time do I have", "how much of my week is meetings",
      /* "are my meetings out of control" is claimed by the availability
         tool. Defensible either way and recorded rather than fought: the
         shape of a week and whether somebody is free are close enough
         that a tie here is a judgement, not a bug. */
      "when am I most free",
      "which hours should I protect",
    ],
  },
  {
    tool: "get_financials_metric",
    what: "the numbers",
    phrasings: [
      "what was our revenue last quarter", "how much did we spend this month",
      "what is our ARR", "what are our costs year to date",
      "show me the P&L for last year", "what is our burn rate",
      "how much cash do we have", "what is our margin",
      "what did we spend on cloud", "how are we doing on revenue",
    ],
  },
  {
    /* Recent mail is the widget's job; a targeted search is the mail
       tool's. The sweep expected one tool for both and was wrong about
       which, which is worth recording: a miss here was partly my own
       expectation rather than the product's. */
    tool: "email_thread_widget",
    what: "what came in",
    phrasings: [
      "what came in overnight", "any new email", "check my inbox",
      "what emails came in today", "show me my email", "inbox",
    ],
  },
  {
    tool: "search_mail",
    what: "finding a particular email",
    phrasings: [
      "did anyone email me about the invoice",
      "find emails from Dana about the warranty claim",
      "show emails to the dealer group",
      "any emails about the recall",
      /* "anything from the dealer group" is left out on purpose: without
         the word mail or email in it, "anything from X" is as likely to
         be about a document or a supplier as about a mailbox. */
    ],
  },
  {
    tool: "task_list_widget",
    what: "what is waiting on somebody",
    phrasings: [
      "what is waiting on me", "show me my tasks", "what do I owe people",
      "what is on my plate", "my open tasks", "what have I got outstanding",
      "what am I supposed to be doing today", "anything overdue",
    ],
  },
  {
    tool: "meeting_prep",
    what: "getting ready for a meeting",
    phrasings: [
      "prep me for my next meeting", "brief me on my 10am",
      "what do I need to know before this call", "get me ready for the meeting",
      "who am I meeting and what about",
    ],
  },
  {
    tool: "who_is",
    what: "who somebody is",
    phrasings: [
      "who is Dana", "who is dana@dealer.test", "tell me about Ray Okonkwo",
      "who am I dealing with here", "what do we know about this person",
    ],
  },
  {
    tool: "cross_tool_insights_widget",
    what: "patterns across tools",
    phrasings: [
      "give me cross-tool insights", "what should I know",
      "any insights", "show me insights", "what is happening across my tools",
      "what patterns do you see",
    ],
  },
  {
    tool: "compare_across_sources",
    what: "where two systems disagree",
    phrasings: [
      "compare contacts across systems", "compare our customers across both",
      "where do our systems disagree about contacts", "contact drift between systems",
      "do our two CRMs agree",
    ],
  },
  {
    tool: "dark_data",
    what: "what nobody reads",
    phrasings: [
      "what is in the legacy database that nobody uses", "show me the dark data",
      "unused columns", "what data are we not using",
      "what is in there that we have never looked at",
    ],
  },
  {
    tool: "search_github_pull_requests",
    what: "open code review",
    phrasings: [
      "what PRs are open", "any pull requests waiting", "show me open PRs",
      "what is waiting for review", "whose PR needs looking at",
    ],
  },
  {
    tool: "create_message_form",
    what: "sending word to somebody",
    phrasings: [
      "message the team that the car is ready", "tell the team it is ready for review",
      "send a note to Dana about the delay", "let the dealer know the part arrived",
      "post to the channel that we are live",
    ],
  },
  {
    tool: "create_calendar_event_form",
    what: "putting something in the diary",
    phrasings: [
      "book me 30 minutes with Dana tomorrow", "schedule a call with the dealer group",
      "set up a meeting for Thursday at 2", "put a hold in for the handover",
      "block an hour tomorrow morning",
    ],
  },
  {
    tool: "search_external_records",
    what: "finding a record in a connected system",
    phrasings: [
      "find the customer Ackerman", "look up the account for Dana",
      "search the CRM for the dealer group", "pull up the contact for Ray",
      "find the deal for the Cayenne",
    ],
  },
  {
    tool: "filter_external_records",
    what: "narrowing records down",
    phrasings: [
      "deals over 50k closing this month", "show me deals stuck in proposal",
      "opportunities over $100k", "contacts owned by Dana",
      "which deals are closing this quarter",
    ],
  },
  {
    tool: null,
    what: "things nothing should claim",
    phrasings: [
      "which warranty claims are open", "how many repair orders are still open",
      "the carrier rejected the claim, what now", "we are in arrears on two accounts",
      "the car arrived damaged, who do I tell",
      "what did the technician write on the repair order",
      "my customer is angry about a delay, what do I say",
      "can you see what I mean", "can you see if the invoice went out",
      "hi, can you find the Ackerman invoice",
    ],
  },
];

function claimants(message: string): string[] {
  const out: string[] = [];
  for (const tool of getTools() as unknown as Array<{
    name: string;
    matchIntent?: (m: string) => unknown;
  }>) {
    try {
      if (tool.matchIntent && tool.matchIntent(message)) out.push(tool.name);
    } catch {
      /* a matcher that throws has its own test */
    }
  }
  return out;
}

const missesOnly = process.argv.includes("--misses-only");
let total = 0;
let missed = 0;
let trespassed = 0;

for (const cap of CAPABILITIES) {
  const lines: string[] = [];
  for (const phrase of cap.phrasings) {
    total++;
    const hits = claimants(phrase);
    if (cap.tool === null) {
      /* Nothing should claim these. Anything that does is answering for
         a domain it does not cover. */
      if (hits.length > 0) {
        trespassed++;
        lines.push(`  CLAIMED by ${hits.join(", ")}  "${phrase}"`);
      } else if (!missesOnly) {
        lines.push(`  ok                              "${phrase}"`);
      }
      continue;
    }
    if (!hits.includes(cap.tool)) {
      /* A phrasing claimed by the WRONG tool is worse than one that
         reaches a model. A model gives a vague answer; a wrong tool acts.
         "add a task to call the dealer" was claimed by the CRM record
         writer, which would put a confirmation dialog in front of
         somebody offering to create a record in a system they never
         mentioned. Counted as trespass, and it fails the run. */
      if (hits.length > 0) {
        trespassed++;
        lines.push(`  WRONG TOOL  ${hits.join(", ").padEnd(22)}"${phrase}"`);
      } else {
        missed++;
        lines.push(`  MISS  ${"reaches a model".padEnd(24)}"${phrase}"`);
      }
    } else if (!missesOnly) {
      lines.push(`  ok    ${cap.tool.padEnd(24)}"${phrase}"`);
    }
  }
  if (lines.length > 0) {
    console.log(`\n── ${cap.what}${cap.tool ? ` → ${cap.tool}` : " → nothing"}`);
    for (const l of lines) console.log(l);
  }
}

console.log(
  `\n${total} phrasings. ${missed} reach no tool and would cost a model call. ` +
    `${trespassed} are claimed by a tool that should not answer them.`,
);
/* A miss is a gap worth closing, not a broken build: the product answers,
   just expensively and from whatever the knowledge base had nearest. */
if (trespassed > 0) process.exitCode = 1;
