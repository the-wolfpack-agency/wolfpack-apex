/** @jest-environment node */
/**
 * The safety gates on mining real prompts.
 *
 * Every case here is a real hazard from real data on this workspace: a card
 * number and a national-insurance number typed into the assistant, and action
 * prompts like "send this to Nick" that would fire a real send if replayed.
 * The harness runs each mined prompt through the live assistant, so a gate that
 * leaks one of these is not a test smell, it is a user's PII in a git file or a
 * message sent to somebody who did not expect it.
 */

import { minePrompts } from "../prompt-mining";

describe("PII never survives mining", () => {
  it("drops a prompt carrying a card number", () => {
    const out = minePrompts([{ query: "what did we charge to 4332356789890077 last week?" }]);
    expect(out).toEqual([]);
  });

  it("drops a prompt carrying a national-insurance number", () => {
    const out = minePrompts([{ query: "is employee NI number QQ123456C on the payroll?" }]);
    expect(out).toEqual([]);
  });

  it("drops a prompt carrying an email address", () => {
    expect(minePrompts([{ query: "what did dana@example.com ask about?" }])).toEqual([]);
  });

  /* Not scrubbed and kept: dropped. A "[CREDIT_CARD_1]" prompt is a corpus
     built from someone's card number and tests nothing real. */
  it("does not keep a redacted form of a sensitive prompt", () => {
    const out = minePrompts([{ query: "charge 4332356789890077 please" }]);
    expect(out.join(" ")).not.toContain("CREDIT_CARD");
    expect(out).toEqual([]);
  });
});

describe("actions are never replayed", () => {
  it.each([
    "send this to Nick Homyk",
    "log this for HR",
    "upload the signed contract",
    "schedule a call with the client",
    "delete the old deal",
    "assign the ticket to me",
  ])("drops the action prompt %j", (q) => {
    expect(minePrompts([{ query: q }])).toEqual([]);
  });

  /* A question that merely mentions an action word in passing is still a
     question. The verb boundary keeps "what did we send last week" out because
     it could be read as an instruction; that is the safe direction to err. */
  it("keeps a plainly read-only question", () => {
    expect(minePrompts([{ query: "what are my tasks today?" }])).toEqual(["what are my tasks today?"]);
  });
});

describe("what it keeps", () => {
  it("keeps question-shaped read-only prompts and dedupes them", () => {
    const out = minePrompts([
      { query: "what does the Abrashoff contract say?" },
      { query: "What does the Abrashoff contract say?" }, // same, different case
      { query: "how much did the printer cost?" },
    ]);
    expect(out).toEqual(["what does the Abrashoff contract say?", "how much did the printer cost?"]);
  });

  it("drops fragments and keyword dumps that are not questions", () => {
    /* "policy time off" and "2026 academy strategy" are real prompts, but they
       are search terms, not questions the assistant answers in prose. The
       harness is about answers, so it wants the ones phrased as questions. */
    const out = minePrompts([{ query: "policy time off" }, { query: "2026 academy strategy" }]);
    expect(out).toEqual([]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ query: `what is item number ${i}?` }));
    expect(minePrompts(many, 5)).toHaveLength(5);
  });
});
