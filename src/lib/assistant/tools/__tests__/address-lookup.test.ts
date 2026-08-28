/**
 * An address typed on its own is a lookup, not a conversation.
 *
 * MEASURED ON A REAL TURN, 2026-08-28. "69 West 43rd street New York, NY
 * 10009" reached no tool, went to a model, and came back:
 *
 *   "No results found for '69 West 43rd Street, New York, NY 10009'. If this
 *    is a search for a specific contact, record, or document, please clarify."
 *
 * 1,659 tokens and several seconds to say what search already knew, with the
 * token count displayed beside it. Somebody pasting an address is looking it
 * up: against a receipt, a venue, a client site, a contact record. Search can
 * answer that, and answers it in milliseconds.
 *
 * WHY THIS IS NARROW RATHER THAN A RULE ABOUT UNGROUNDED QUESTIONS.
 *
 * Across ninety days, 81 per cent of model answers with no grounding at all
 * said nothing useful: 144 of 177. That looks like a case for skipping the
 * model whenever retrieval is empty, and it is not. The remaining 33 include
 * genuinely good conversational turns, "I'll document this and forward it to
 * Nick Homyk for review", "I understand your frustration", and one safety
 * response to a string that looked like a card number. A product that answers
 * those robotically is worse, not cheaper.
 *
 * So this acts on the shape that is unambiguously a lookup, and leaves the
 * conversation alone. A false positive sends a real question to search, which
 * answers "no results" - worse than a model answering it well - so the tests
 * below spend more effort on what must NOT match than on what must.
 */
import "../index";
import { addressQuery } from "@/lib/assistant/tools/search";
import { getTools } from "@/lib/assistant/tools/registry";

function claimants(message: string): string[] {
  const out: string[] = [];
  for (const t of getTools() as unknown as Array<{
    name: string;
    matchIntent?: (m: string) => unknown;
  }>) {
    try {
      if (t.matchIntent && t.matchIntent(message)) out.push(t.name);
    } catch {
      /* A throwing matcher is its own bug with its own test. */
    }
  }
  return out;
}

describe("an address reaches search instead of a model", () => {
  it.each([
    "69 West 43rd street New York, NY 10009",
    "1600 Pennsylvania Ave NW, Washington, DC 20500",
    "10100 Dream Tree Boulevard, Lake Buena Vista, Florida 32836",
    /* The UK form was missing on the first pass and fell through to a model.
       This engagement is US-centred, but an address is an address. */
    "221 Baker Street, London NW1 6XE",
  ])("recognises %j", (address) => {
    expect(addressQuery(address)).toEqual({ query: expect.any(String) });
  });

  it("routes the reported turn to search rather than to nothing", () => {
    expect(claimants("69 West 43rd street New York, NY 10009")).toContain("search");
  });
});

describe("what must not be mistaken for an address", () => {
  /* THE EXPENSIVE DIRECTION. Sending a real question to search gets "no
     results", which is worse than a model answering it well. Each of these
     starts with a number, which is the strongest address signal, and none of
     them is an address. */
  it.each([
    ["43 things to do before the launch", "a count, and no street type"],
    ["10 Downing Street is famous", "a sentence about a street, not an address"],
    ["5 ways to improve onboarding", "a listicle"],
    ["2026 budget review", "a year"],
    ["3 open tasks today", "a task count"],
    ["12 Angry Men", "a title"],
  ])("leaves %j alone: %s", (message) => {
    expect(addressQuery(message)).toBeNull();
  });

  /* Questions that already belong to a tool must keep belonging to it. */
  it.each(["what is our revenue this month", "who is on the team", "how many open tasks do I have"])(
    "does not disturb %j",
    (message) => {
      expect(addressQuery(message)).toBeNull();
      expect(claimants(message).length).toBeGreaterThan(0);
    },
  );

  /* A street name with no house number is a place being discussed, not an
     address being looked up. */
  it("requires a leading house number", () => {
    expect(addressQuery("West 43rd street New York, NY 10009")).toBeNull();
  });

  /* A house number and a postcode with no street type is a reference, not an
     address. */
  it("requires a street type", () => {
    expect(addressQuery("69 West 43rd New York, NY 10009")).toBeNull();
  });

  /* Length bounds, so a paragraph containing an address is not swallowed
     whole and searched verbatim. */
  it("ignores something far too long to be an address", () => {
    const paragraph =
      "69 West 43rd street New York, NY 10009 " + "and then a great deal more prose ".repeat(6);
    expect(addressQuery(paragraph)).toBeNull();
  });
});
