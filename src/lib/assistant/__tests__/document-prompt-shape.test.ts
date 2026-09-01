/**
 * The one place that teaches a new person how to ask must teach the shape that
 * works.
 *
 * Measured against the live deployment 2026-08-29:
 *
 *   ANSWER  "what are the payment terms in our SOW?"      2,092ms  + citation
 *   ANSWER  "when is the final payment due in our SOW?"     552ms  direct
 *   COUNT   "what do our documents say about onboarding"  1,092ms  "Found 4 results"
 *   COUNT   "what does the onboarding document say"       1,296ms  "Found 3 results"
 *   COUNT   "find documents about onboarding"             1,516ms  "Found 3 results"
 *   COUNT   "summarize the onboarding document"           1,439ms  "Found 3 results"
 *
 * The product answers QUESTIONS and does not take document COMMANDS. The
 * onboarding chip used the count shape and promised "answer with the source
 * attached", so the first thing a new person learned was the phrasing that
 * works least well. Somebody who has to guess their way to the working form
 * concludes the product cannot answer.
 */
import { welcomePromptsForRole } from "@/lib/assistant/welcome-prompts";

function documentPrompt() {
  const all = welcomePromptsForRole("ops");
  const p = all.find((x) => x.requires === "documents");
  if (!p) throw new Error("no document prompt is offered at all");
  return p;
}

describe("the document starter prompt", () => {
  it("is offered", () => {
    expect(documentPrompt()).toBeDefined();
  });

  /* THE FIX. A question, not a command. */
  it("is phrased as a question", () => {
    expect(documentPrompt().text.trim()).toMatch(/\?$/);
  });

  /* THE MEASURED FAILURE MODES. Each of these routes to search and returns a
     count, so none of them belongs in the prompt that teaches people how to
     ask. */
  it.each(["find", "summarize", "summarize", "search", "list"])(
    "does not open with the command verb %s",
    (verb) => {
      expect(documentPrompt().text.toLowerCase().trim().startsWith(verb)).toBe(false);
    },
  );

  it("does not use the 'what do our documents say' shape that returns a count", () => {
    expect(documentPrompt().text.toLowerCase()).not.toMatch(/what do (?:our|the) documents say/);
  });

  /* The description is the only place the rule is explained, so it has to
     actually explain it rather than promise an outcome the phrasing will not
     produce. The old one said "answer with the source attached" above a prompt
     that returned "Found 4 results". */
  it("tells the reader the rule instead of promising an outcome", () => {
    const d = documentPrompt().description ?? "";
    expect(d.length).toBeGreaterThan(30);
    expect(d.toLowerCase()).toMatch(/question/);
    /* Names at least one of the shapes that does NOT work, because a rule
       without its counter-example is advice nobody applies. */
    expect(d.toLowerCase()).toMatch(/find|summar/);
  });

  /* MUST NOT DEPEND ON OUR CORPUS. A prompt naming a document only we hold
     fails on every client deployment and teaches nothing there. */
  it("does not name a document only we have", () => {
    expect(documentPrompt().text).not.toMatch(/\bSOW\b|viaPeople|wolfpack/i);
  });
});
