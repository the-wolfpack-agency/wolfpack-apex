/**
 * "Can you send an email for me" is a capability question.
 *
 * WHY IT STOPPED REACHING A MODEL. It was not treated as one, so it went to a
 * model and the model answered from what a general assistant would say. Read
 * back from the deployed assistant on 2026-08-28, AFTER the stored copies had
 * been purged and the system prompt rewritten to forbid exactly this:
 *
 *   "can you send an email for me" -> "I cannot send emails directly."
 *   "what files can you see"       -> "I cannot see files directly."
 *
 * Both false, both produced live, and in the same session the identical
 * question had answered "Yes, I can draft an email for you." Same prompt,
 * opposite answers, minutes apart. An instruction is not a control.
 *
 * The registry knows what exists, the gate knows what this reader may run, and
 * between them the answer is a lookup. These tests hold that lookup to the two
 * things that matter: it must answer the questions people ask, and it must NOT
 * answer questions that merely look like them.
 */
import "../index";
import { matchCapabilitiesIntent, areaForTopic } from "../capabilities-tool";

describe("questions about what we can do", () => {
  /* The two measured failures first, then the phrasings around them. */
  it.each([
    ["can you send an email for me", "send an email"],
    ["could you send an email", "send an email"],
    ["what files can you see", "files"],
    ["can you read my calendar", "read my calendar"],
    ["are you able to check my tasks", "check my tasks"],
    ["can you look at my invoices", "look at my invoices"],
  ])("%j is answered from the registry, not by a model", (message, topic) => {
    expect(matchCapabilitiesIntent(message)).toEqual({ topic });
  });

  /* The menu question keeps its own answer. A reader asking what the product
     does wants everything; a reader asking about email wants email. */
  it.each(["what can you do", "what can you help me with", "where do I start"])(
    "%j still asks for the whole menu",
    (message) => {
      expect(matchCapabilitiesIntent(message)).toEqual({});
    },
  );
});

describe("questions that only look like capability questions", () => {
  /* THE OBJECT DISTINCTION, one shape further out than the menu matcher draws
     it. "Can you help me with the Detroit account" is about Detroit. It
     matched on the word "account" and would have answered a real question
     about a real customer with a list of CRM tools. */
  it.each([
    "can you help me with the Detroit account",
    "can you help us with the invoices from Acme",
    "can you help with the calendar",
  ])("%j is about the thing, not about us", (message) => {
    expect(matchCapabilitiesIntent(message)).toBeNull();
  });

  /* A LOOKUP, NOT A CAPABILITY QUESTION. The dealership corpus asserts nothing
     may claim this; it was claimed on the word "invoice". The tell is the
     subordinate clause. */
  it.each([
    "can you see if the invoice went out",
    "can you check whether the email sent",
  ])("%j asks about a fact, not about us", (message) => {
    expect(matchCapabilitiesIntent(message)).toBeNull();
  });

  /* CONNECTIVITY HAS A BETTER ANSWER ELSEWHERE. The integrations tool reads
     live connection status; this one would answer from the registry and say
     yes about a mailbox nobody has linked. */
  it.each([
    "can you see my email?",
    "do you have access to our CRM?",
  ])("%j belongs to the integrations tool", (message) => {
    expect(matchCapabilitiesIntent(message)).toBeNull();
  });

  /* A bare "drive" matched OneDrive and answered "can you drive a car" with a
     document library. */
  it("does not read driving as a document library", () => {
    expect(matchCapabilitiesIntent("can you drive a car")).toBeNull();
    expect(areaForTopic("drive a car")).toBeNull();
  });

  /* Claimed only when the topic maps to something we do. A confident list of
     mail tools in answer to a question about bookkeeping is the wrong-tool
     failure this repo keeps finding, and it would be worse from a tool that
     never says it is unsure. */
  it.each([
    "can you reconcile the trial balance",
    "can you fix the gearbox",
    "can you speak french",
  ])("%j is left for something that can actually answer it", (message) => {
    expect(matchCapabilitiesIntent(message)).toBeNull();
  });
});

describe("topics map to the part of the job they belong to", () => {
  it.each([
    ["send an email", "Mail and people"],
    ["my calendar", "Calendar and meetings"],
    ["check my tasks", "Work and tasks"],
    ["files", "Knowledge"],
    ["sharepoint", "Knowledge"],
    ["onedrive", "Knowledge"],
    ["the invoices", "Money"],
    ["our customers", "Customers and records"],
  ])("%j belongs to %s", (topic, area) => {
    expect(areaForTopic(topic)).toBe(area);
  });

  it("returns null for a topic that is not part of this product", () => {
    expect(areaForTopic("the gearbox")).toBeNull();
    expect(areaForTopic("french")).toBeNull();
  });
});
