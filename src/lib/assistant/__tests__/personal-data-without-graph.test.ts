/**
 * Two answers to the same cause, in the same minute, and only one is true.
 *
 * Measured against the live deployment 2026-08-29 with Microsoft unconnected:
 *
 *   "what are my tasks?"        -> "Microsoft is not connected yet, so I
 *                                   cannot read your tasks. Connect it in
 *                                   Settings."          (1,195ms, no model)
 *
 *   "what did I miss this week?" -> "I cannot access your personal information
 *                                   like your calendar, tasks, or emails."
 *                                                        (5,189ms, a model)
 *
 * The second reads as a policy refusal, as though we had decided not to look.
 * The truth is that nobody finished connecting an account, and those two
 * deserve opposite reactions: one is a dead end, the other is a two-minute
 * setup step. It also cost five seconds and a model call to produce something
 * the system already knew.
 */
import {
  checkPersonalDataQuestion,
  MICROSOFT_NOT_CONNECTED,
} from "@/lib/assistant/personal-data-without-graph";

describe("asking about your own week with nothing connected", () => {
  it.each([
    "what did I miss this week?",
    "what is on my calendar today",
    "catch me up",
    "show me my inbox",
    "what are my meetings tomorrow",
  ])("answers %s deterministically instead of buying a refusal", (q) => {
    expect(checkPersonalDataQuestion(q, false).answer).toBe(MICROSOFT_NOT_CONNECTED);
  });

  /* It must name the setup step. A refusal that leaves somebody stuck is the
     failure this replaces, not a smaller version of it. */
  it("says what to do about it", () => {
    expect(MICROSOFT_NOT_CONNECTED).toMatch(/connect it in settings/i);
    expect(MICROSOFT_NOT_CONNECTED).toMatch(/not connected/i);
  });

  /* It must NOT sound like a decision we made. */
  it("does not read as a policy refusal", () => {
    expect(MICROSOFT_NOT_CONNECTED).not.toMatch(/cannot access your personal information/i);
  });
});

describe("what it deliberately leaves alone", () => {
  /* Document questions are the product's core and have nothing to do with
     Graph. Swallowing one of these would be far worse than the defect. */
  it.each([
    "what are the payment terms in our SOW?",
    "what does the onboarding doc say",
    "what did the team ship this week",
    "who is on my team?",
  ])("does not fire on %s", (q) => {
    expect(checkPersonalDataQuestion(q, false).answer).toBeUndefined();
  });

  /* CONNECTED IS THE WHOLE POINT OF THE FLAG. With an account attached the
     model has real data to work from, so this gate must get out of the way
     entirely or it would replace working answers with a setup notice. */
  it.each(["what did I miss this week?", "what is on my calendar today"])(
    "stays out of the way when Microsoft IS connected: %s",
    (q) => {
      const r = checkPersonalDataQuestion(q, true);
      expect(r.asksAboutOwnGraphData).toBe(true);
      expect(r.answer).toBeUndefined();
    },
  );

  it("ignores an empty message", () => {
    expect(checkPersonalDataQuestion("", false).asksAboutOwnGraphData).toBe(false);
  });
});

/**
 * A how-to is about the product, not about a week.
 *
 * The existing page-facts tests caught this gate on its first run: "how do I
 * use Calendar" contains "I" and "Calendar", so it matched, and page facts
 * answers that question at zero tokens. The "I" in "how do I use X" is not
 * possessive. Swallowing these would have replaced a working feature with a
 * setup notice.
 */
describe("how-to questions belong to page facts, not to this gate", () => {
  it.each([
    "how do I use Calendar",
    "how do I use the calendar",
    "how to see my tasks",
    "where do I find my inbox",
    "how can I check my email",
  ])("does not fire on %s", (q) => {
    expect(checkPersonalDataQuestion(q, false).answer).toBeUndefined();
  });

  /* The distinction has to survive: these mention the same nouns and mean the
     opposite thing. */
  it.each([
    "what did I miss this week?",
    "what is on my calendar today",
    "show me my inbox",
  ])("still fires on the real question %s", (q) => {
    expect(checkPersonalDataQuestion(q, false).answer).toBeDefined();
  });
});
