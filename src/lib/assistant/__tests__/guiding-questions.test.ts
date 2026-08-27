/**
 * Ask, rather than invent.
 *
 * Reaching the AI fallback means no tool matched, no page facts hit, and the
 * Brain returned nothing. The model is then asked a question about this
 * business with no material about this business in front of it, and the only
 * thing it can do is write something plausible. That is exactly how the
 * assistant invented a product and then remembered it as fact.
 *
 * A question with concrete options moves somebody forward. An invented answer
 * moves them backward and spends a model call doing it.
 *
 * THE RESTRAINT IS THE DESIGN. buildChoices always returns something, falling
 * back to declared order when nothing scores, which is right for a menu after
 * a failed answer and wrong for deciding whether the product has anything to
 * offer at all. Offering the first four chips to somebody asking about
 * something else looks like relevance and leads them further away. So this
 * only fires when a chip genuinely overlaps what was typed, and otherwise the
 * model answers exactly as before.
 */

import { buildChoices } from "@/lib/assistant/choices";
import "@/lib/assistant/tools";

const ROLE = "cto";

describe("choices offered only when they are relevant", () => {
  it("offers document chips for a document question", () => {
    const guided = buildChoices("can you add a file to the library", ROLE, { relevantOnly: true });
    expect(guided.length).toBeGreaterThan(0);
    expect(guided.map((c) => c.label)).toContain("Add a document");
  });

  it("offers nothing for a question the product has no surface for", () => {
    /* THE ASSERTION THAT KEEPS THIS HONEST. With nothing relevant, the
       assistant must fall through to the model rather than offer a menu that
       has nothing to do with the question. */
    const guided = buildChoices("what is the capital of France", ROLE, { relevantOnly: true });
    expect(guided).toEqual([]);
  });

  it.each([
    "explain quantum tunnelling",
    "write me a haiku",
    "what is 17 times 4",
  ])("%s gets no chips, so the model still answers it", (prompt) => {
    expect(buildChoices(prompt, ROLE, { relevantOnly: true })).toEqual([]);
  });

  it("still returns a full menu when relevance is not required", () => {
    /* The existing post-failure menu must not become empty. An empty panel
       after a failed answer is a dead end, which is why relevantOnly is opt
       in rather than the default. */
    const menu = buildChoices("what is the capital of France", ROLE, {});
    expect(menu.length).toBeGreaterThan(0);
  });

  it("never offers a chip whose integration is disconnected, even when relevant", () => {
    /* The two rules compose: relevant AND usable. A relevant dead chip is
       still a dead chip. */
    const guided = buildChoices("what is our revenue this month", ROLE, {
      relevantOnly: true,
      knownDisconnected: new Set(["quickbooks"]),
    });
    expect(guided.map((c) => c.label)).not.toContain("A financial figure");
  });
});

describe("the wording", () => {
  it("does not apologise, and says why it is asking", () => {
    /* "Sorry, I could not find anything" tells somebody the product failed.
       Saying it would rather ask than guess tells them it is being careful,
       which is both truer and the thing being sold. */
    const lead =
      "I do not have anything on that yet, so I would rather ask than guess. Did you mean one of these?";
    expect(lead).not.toMatch(/sorry|apolog|unfortunately/i);
    expect(lead).toMatch(/rather ask than guess/);
    expect(lead).not.toContain("—");
  });
});
