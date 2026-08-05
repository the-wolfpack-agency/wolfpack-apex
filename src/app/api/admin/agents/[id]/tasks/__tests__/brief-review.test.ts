/** @jest-environment node */
/**
 * The agent asks before it starts.
 *
 * reviewPrompt shipped 2026-08-02 as a panel on the Agent fleet page. Measured
 * on production three days later: agent.brief_reviewed had fired ZERO times,
 * on a page viewed 114 times, while 217,744 other events were recorded. It was
 * not undiscovered — it was on a page where nobody writes a brief.
 *
 * Task assignment IS where a brief arrives, so the check runs here. These pin
 * the two properties that decide whether it survives contact with real use:
 * it must never block work, and it must never record the brief text.
 */
import { reviewPrompt } from "@/lib/agents/prompt-review";

describe("the reviewer, as the agent's clarifying question", () => {
  test("a thin brief produces questions, not a refusal", () => {
    const r = reviewPrompt("fix the thing");
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) {
      /* A question, then how to answer it: "What would you check to accept
         this? Name the screen, the command or the assertion." */
      expect(f.ask).toContain("?");
      expect(f.ask.length).toBeGreaterThan(10);
    }
  });

  test("each question names the fact it is asking for", () => {
    /* "Be more specific" is useless. The value is naming WHICH fact is absent. */
    for (const f of reviewPrompt("do the migration").findings) {
      expect(f.missing).toBeTruthy();
      expect(f.dimension).toBeTruthy();
    }
  });

  test("a brief that carries the facts comes back clean", () => {
    /* The line this has to hold: a checker that fires on every input is one
       nobody reads. If this ever starts failing, the rules got greedy. */
    const good = [
      "Add a status column to success_stories.",
      "It has to work on the deployed URL https://weekendwithporsche.com, not just local.",
      "You will know it worked when GET /api/admin/stories returns 200 with a status field for every row.",
      "Do not change the existing rows' visibility: they must stay published.",
      "Reuse the existing migration runner at scripts/migrate.mjs rather than writing a new one.",
      "Land it as a pull request; I will review before it merges.",
      "I have set DATABASE_URL already, so nothing is blocked on me.",
    ].join(" ");
    expect(reviewPrompt(good).findings).toHaveLength(0);
  });

  test("it is deterministic — same brief, same answer", () => {
    /* No model call. It can be read, argued with, and unit-tested, and it costs
       nothing to run on every assignment. */
    const a = reviewPrompt("ship the thing by friday");
    const b = reviewPrompt("ship the thing by friday");
    expect(a).toEqual(b);
  });

  test("it never invents an answer, only asks", () => {
    /* `suggested` appends prompts to fill in. A reviewer that guessed would put
       words in the assignee's mouth and be confidently wrong. */
    const r = reviewPrompt("make the dashboard faster");
    expect(r.suggested).toContain("make the dashboard faster");
    for (const f of r.findings) expect(r.suggested).toContain(f.ask);
  });

  test("an empty brief does not throw", () => {
    expect(() => reviewPrompt("")).not.toThrow();
  });
});

describe("what may be recorded", () => {
  test("a finding carries no brief text, so the event cannot leak one", () => {
    /* The event records dimensions and a count. The brief can name a client and
       is never stored — that is the promise the original surface made and this
       one keeps. */
    const brief = "Migrate ACME Motors' production database tonight";
    for (const f of reviewPrompt(brief).findings) {
      const serialized = JSON.stringify({ dimension: f.dimension, missing: f.missing });
      expect(serialized).not.toContain("ACME");
    }
  });
});
