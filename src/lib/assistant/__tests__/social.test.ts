/**
 * "hi" is not a search.
 *
 * Five turns of a first conversation with the deployed assistant, from
 * somebody who had just arrived:
 *
 *   > hi
 *   < Here's what the brain has on this: BA101 Mobile Coach Rules.csv...
 *   > I am new here, what now?
 *   < Here's what the brain has on this: NHomyk_NY W4.pdf...
 *   > thanks
 *   < Did you mean one of these? Tap a chip to run it.
 *
 * A greeting returned a spreadsheet of chatbot rules. "I am new here"
 * returned a tax form. A thank-you was answered with a disambiguation
 * prompt.
 *
 * None of that is retrieval working badly. Retrieval worked as built:
 * given any string it returns the nearest document, and for "hi" there is
 * no nearest document, only a least-far one.
 */

export {};

import { detectSocial, socialAnswer } from "../social";

describe("turns that carry no question", () => {
  it.each([
    ["hi", "greeting"],
    ["Hello", "greeting"],
    ["hey there", "greeting"],
    ["good morning", "greeting"],
    ["thanks", "thanks"],
    ["thank you so much", "thanks"],
    ["cheers", "thanks"],
    ["bye", "farewell"],
    ["see you", "farewell"],
    ["I am new here", "new_here"],
    ["new here, what now?", "new_here"],
    ["first time here", "new_here"],
  ])("reads %p as %s", (message, kind) => {
    expect(detectSocial(message)).toBe(kind);
  });
});

describe("turns that only start like one", () => {
  it.each([
    "hi, can you find the Ackerman invoice",
    "thanks for the report, can you send it on",
    "good morning, what is on today",
    "hello world documentation",
    "new customer intake process",
    "bye bye policy document",
  ])("leaves %p to the machinery built for subjects", (message) => {
    /* A greeting detector that swallowed "hi, can you find the Ackerman
       invoice" would answer a real question with a wave, which is a worse
       failure than the one this fixes. */
    expect(detectSocial(message)).toBeNull();
  });

  it("does not treat a long message as a bare greeting", () => {
    expect(detectSocial(`hi ${"there ".repeat(20)}`)).toBeNull();
  });
});

describe("what it says back", () => {
  it("uses a first name when there is one, and reads without when there is not", () => {
    expect(socialAnswer("greeting", "Dana")).toContain("Hello Dana");
    expect(socialAnswer("greeting")).toContain("Hello.");
  });

  it("gives a greeting one thing to try, not a menu", () => {
    /* A menu at hello is a wall, and the capability tool is one question
       away for anybody who wants the whole list. */
    const a = socialAnswer("greeting");
    expect(a).toContain("what I can do");
    expect(a.split("\n").filter((l) => l.trim().startsWith("-"))).toHaveLength(0);
  });

  it("points somebody new at a chain once they want more than one thing", () => {
    expect(socialAnswer("new_here")).toContain("automate");
  });

  it("acknowledges a thank-you and stops", () => {
    /* Answering a courtesy with suggestions is how a product talks past
       somebody who was being polite. */
    const a = socialAnswer("thanks");
    expect(a.length).toBeLessThan(40);
    expect(a).not.toMatch(/try|ask me|you can/i);
  });
});

/**
 * Two more from the production backlog.
 *
 * Both were filed as questions nobody could answer. Neither is a
 * question: "how are you?" and "what is up?" are somebody opening a
 * conversation, and answering them with a document search is the same
 * failure as answering "hi" with a tax form.
 */
describe("asking how it is", () => {
  it.each(["how are you?", "what is up?", "hows it going", "you ok"])(
    "reads %p as a greeting",
    (m) => {
      expect(detectSocial(m)).toBe("greeting");
    },
  );

  it("leaves the same words alone when they carry a subject", () => {
    expect(detectSocial("what is up with the pipeline")).toBeNull();
    expect(detectSocial("how are you planning to handle the recall")).toBeNull();
  });
});
