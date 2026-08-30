/**
 * What happened to a person after the answer, derived rather than instrumented.
 *
 * THE GAP. The product emits 133 assistant events and every one describes what
 * the SYSTEM did. Not one describes what the PERSON did in response, and the
 * response is where frustration lives. That is why the customer-success view
 * could only say "joined and has done nothing since": it was the only
 * behavioural signal that existed.
 *
 * Measured on 90 days of production, 2026-08-30, through this module:
 *
 *     12,202 conversations   24,397 messages
 *     misses 400   dead ends 387   followed up 13
 *     re-asks 40   single-turn conversations 12,123   rated answers 3
 *
 * DERIVED IS THE POINT. Every figure comes from rows stored since day one. An
 * event would start the count at zero today and know nothing about the last
 * three months.
 */

import {
  isMiss,
  isAskedWhich,
  isOutage,
  similarity,
  summariseOutcomes,
  MISS_PATTERNS,
} from "@/lib/insights/answer-outcomes";

function msg(
  conversation_id: string,
  role: string,
  content: string,
  minute: number,
  rating: number | null = null,
) {
  return {
    conversation_id,
    role,
    content,
    rating,
    created_at: new Date(Date.UTC(2026, 7, 30, 12, minute)).toISOString(),
  };
}

/**
 * THE FRAGILE PART, PINNED. This classifies by prose, so it breaks silently
 * when somebody rewords an answer. These are the exact sentences the product
 * produces today; if one changes, this fails and the pattern gets updated in
 * the same commit rather than the metric quietly going to zero.
 */
describe("the sentences that mean we have nothing", () => {
  it.each([
    'No results found for "onboarding".',
    "I don't have information on that yet. You can help me learn by adding it to the Knowledge Base",
    "I don't have a confident answer for that. Could you rephrase",
    "Salesforce is not connected yet, so I cannot check it.",
  ])("counts %s as a miss", (text) => {
    expect(isMiss(text)).toBe(true);
  });

  it.each([
    "The payment terms are net 30 from invoice date.",
    "Here's what the brain has on this: **SOW.pdf**",
    "Found 3 results for \"training\".",
    "",
  ])("does not count %s as a miss", (text) => {
    expect(isMiss(text)).toBe(false);
  });

  /* AN OUTAGE IS NOT A MISS, and counting them together would send somebody to
     load more documents when the search index is down. */
  it.each([
    "I could not reach the search index just now, so I only looked at part of what you have.",
    "I could not reach the model that writes answers just now",
  ])("treats %s as an outage, not a gap in the corpus", (text) => {
    expect(isOutage(text)).toBe(true);
    expect(isMiss(text)).toBe(false);
  });

  it("has patterns, so a future edit cannot empty the list unnoticed", () => {
    expect(MISS_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("recognising a question asked again", () => {
  it("sees a rephrase even when the words move", () => {
    expect(similarity("where is the wolfpack NDA doc", "provide me with the NDA doc")).toBeGreaterThan(
      0.4,
    );
  });

  it("does not call two different questions a rephrase", () => {
    expect(similarity("what are the payment terms", "who runs engineering")).toBeLessThan(0.3);
  });

  it("handles empty input without dividing by zero", () => {
    expect(similarity("", "anything")).toBe(0);
    expect(similarity("anything", "")).toBe(0);
  });
});

describe("what happened after the answer", () => {
  /* THE NUMBER THAT MATTERS MOST. A miss nobody pushed past is a request
     nobody filed, and it is invisible to every other signal. */
  it("separates a miss somebody pushed past from one they walked away from", () => {
    const rows = [
      msg("a", "user", "what does the SOW say", 0),
      msg("a", "assistant", 'No results found for "SOW".', 1),
      msg("a", "user", "try the work order instead", 2),
      msg("a", "assistant", "The payment terms are net 30.", 3),
      msg("b", "user", "what is our leave policy", 0),
      msg("b", "assistant", 'No results found for "leave policy".', 1),
    ];
    const o = summariseOutcomes(rows, 90);
    expect(o.misses).toBe(2);
    expect(o.deadEnds).toBe(1);
    expect(o.missesFollowedUp).toBe(1);
  });

  it("counts a rephrase inside the window as a re-ask", () => {
    const rows = [
      msg("a", "user", "collect out RubyCar marketing emails", 0),
      msg("a", "assistant", "Found 0 results.", 1),
      msg("a", "user", "collect our RubyCar marketing emails", 2),
    ];
    const o = summariseOutcomes(rows, 90);
    expect(o.reAsks).toBe(1);
    expect(o.reAskConversations).toBe(1);
  });

  /* Somebody returning an hour later has thought of something new; that is not
     a retry and counting it as one would inflate the signal. */
  it("does not call a question an hour later a re-ask", () => {
    const rows = [
      msg("a", "user", "what are the payment terms", 0),
      msg("a", "user", "what are the payment terms", 90),
    ];
    expect(summariseOutcomes(rows, 90).reAsks).toBe(0);
  });

  it("counts a conversation with one question as single-turn", () => {
    const rows = [
      msg("a", "user", "what are the payment terms", 0),
      msg("a", "assistant", "Net 30.", 1),
      msg("b", "user", "one", 0),
      msg("b", "user", "two", 1),
    ];
    expect(summariseOutcomes(rows, 90).singleTurnConversations).toBe(1);
  });

  it("counts ratings, because a control nobody uses is worth knowing about", () => {
    const rows = [
      msg("a", "user", "q", 0),
      msg("a", "assistant", "an answer", 1, 1),
      msg("a", "assistant", "another", 2, null),
    ];
    expect(summariseOutcomes(rows, 90).ratedAnswers).toBe(1);
  });

  it("reports nothing rather than crashing on an empty window", () => {
    const o = summariseOutcomes([], 90);
    expect(o).toMatchObject({ readable: true, conversations: 0, misses: 0, deadEnds: 0 });
  });
});

/**
 * ASKING WHICH DOCUMENT IS NOT ADMITTING NOTHING.
 *
 * Added 2026-08-30 alongside the fix that made "how much do we owe upfront?"
 * stop quoting a chauffeur invoice and start naming its candidates. The two
 * wordings overlap: the ask OPENS with "I could not find a clear answer",
 * which reads like a miss and is the opposite of one.
 *
 * Counting it as a miss would have taught every downstream measure to prefer
 * the confident wrong answer that was just removed, which is the most
 * expensive way a metric can be wrong.
 */
describe("the product asking which document was meant", () => {
  it.each([
    "I could not find a clear answer to that. The closest things I hold are: - **A** - **B**",
    "I could not find a clear answer. The closest thing I hold is **Invoice 941**.",
  ])("recognises %s", (text) => {
    expect(isAskedWhich(text)).toBe(true);
  });

  /* THE ONE THAT MATTERS. It opens like a miss and must not be counted as one. */
  it("is never counted as a miss", () => {
    const ask =
      "I could not find a clear answer to that. The closest things I hold are: - **A**";
    expect(isAskedWhich(ask)).toBe(true);
    expect(isMiss(ask)).toBe(false);
  });

  it.each([
    'No results found for "onboarding".',
    "The payment terms are net 30.",
    "",
  ])("does not mistake %s for an ask", (text) => {
    expect(isAskedWhich(text)).toBe(false);
  });
});

/**
 * THE MODEL WRITES ITS OWN WAYS OF SAYING "I DO NOT KNOW".
 *
 * The first version of MISS_PATTERNS knew only the deterministic strings, so a
 * model-written refusal landed in single_turn and read as neutral. Found by
 * walking every distinct answer in a 90-day window and reading the ones that
 * sound like a failure and matched nothing:
 *
 *   "I cannot determine who runs engineering based on the information provided."
 *
 * The effect was that the WORST performing origin was the one whose failures
 * were hardest to see, because it is the only one that phrases them
 * differently every time. Widening the patterns moved 187 turns from neutral
 * to dead_end and took the measured base rate from 3.5% to 5.2%.
 */
describe("a refusal the model wrote itself", () => {
  it.each([
    "I cannot determine who runs engineering based on the information provided.",
    "I could not find any details about that in the documents.",
    "I can't locate a record matching that description.",
    "Based on the data provided, I cannot answer that.",
    "There are no records matching this month.",
  ])("counts %s as a miss", (text) => {
    expect(isMiss(text)).toBe(true);
  });

  /* ANCHORED ON THE REFUSAL, NOT ON A TOPIC. A document that happens to
     contain these words is not the assistant refusing, and sweeping it up
     would inflate the failure rate with real answers. */
  it.each([
    "The contract states that the vendor cannot determine pricing unilaterally.",
    "The payment terms are net 30 from invoice date.",
    "Here's what the brain has on this: **SOW.pdf**",
  ])("does not count %s as a miss", (text) => {
    expect(isMiss(text)).toBe(false);
  });

  /* An outage is still not a miss, even though it is now also worded as a
     failure. The fix is different: one is a thin corpus, the other is broken
     plumbing. */
  it("keeps an outage separate from a refusal", () => {
    const outage = "I could not reach the search index just now, so I only looked at part of what you have.";
    expect(isOutage(outage)).toBe(true);
    expect(isMiss(outage)).toBe(false);
  });
});
