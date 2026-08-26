/**
 * How often an ordinary sentence reaches a tool, held as a number.
 *
 * Sixty tools, each deciding for itself whether a message is for it, with a
 * regex written in isolation and never measured against the others. A routing
 * audit on 2026-08-26 gave that arrangement a score: of fifty-one prompts a
 * person would plainly type, twenty-two reached NO tool. Not exotic ones.
 * "what are my tasks". "when is my next meeting". "how many people are on the
 * team".
 *
 * A number nobody prints is a number nobody improves, and a number nobody
 * asserts is a number that quietly goes back down. This is the ratchet.
 */
import { auditRouting, AUDIT_PROMPTS } from "../../../../scripts/routing-audit";

describe("routing coverage", () => {
  /* THE RATCHET. Raise it when the number improves; it cannot fall without
     somebody deliberately editing this line, which is the point. */
  /* Raised from 22 on 2026-08-26 after the day cluster landed. The ratchet only
     ever goes up, and it goes up in the same change that earns it. */
  const FLOOR = 25;

  it(`routes at least ${FLOOR} of the audit prompts to exactly one tool`, async () => {
    const r = await auditRouting();
    expect(r.reachedOne).toBeGreaterThanOrEqual(FLOOR);
  });

  /* Groups where every prompt fails are a missing capability rather than a
     missing phrasing, and they should be argued about rather than absorbed. */
  it("names the clusters that are wholly unreachable", async () => {
    const r = await auditRouting();
    const dead = Object.entries(r.byGroup)
      .filter(([, v]) => v.none === v.total)
      .map(([g]) => g);
    /* status: "what's blocking the pilot", "how is the pilot going", "what's
       left to do". Nothing answers a question about how work is going, which
       is the question a client asks first. Recorded, not hidden. */
    expect(dead).toEqual(["status"]);
  });

  it("keeps the audit corpus from shrinking to flatter the score", async () => {
    const total = Object.values(AUDIT_PROMPTS).reduce((n, p) => n + p.length, 0);
    expect(total).toBeGreaterThanOrEqual(36);
  });
});

describe("the phrasings fixed on 2026-08-26", () => {
  /* Each reached nothing before. They are asserted individually so a later
     edit to either matcher cannot quietly undo them. */
  it.each([
    ["what are my tasks", "task_list_widget"],
    ["what tasks do I have", "task_list_widget"],
    ["when is my next meeting", "calendar_widget"],
    ["what is my next meeting", "calendar_widget"],
  ])("%s reaches %s", async (prompt, tool) => {
    await import("@/lib/assistant/tools");
    const { getTools } = await import("@/lib/assistant/tools/registry");
    const claimed = (getTools() as unknown as Array<{ name: string; matchIntent?: (m: string) => unknown }>)
      .filter((t) => typeof t.matchIntent === "function" && t.matchIntent(prompt) != null)
      .map((t) => t.name);
    expect(claimed).toContain(tool);
  });

  /* Widening a matcher is how a tool starts claiming sentences that were never
     for it, so the negatives are pinned alongside. */
  it.each(["what did we bill Porsche", "what are my options", "when is the client arriving"])(
    "%s still reaches nothing",
    async (prompt) => {
      await import("@/lib/assistant/tools");
      const { getTools } = await import("@/lib/assistant/tools/registry");
      const claimed = (getTools() as unknown as Array<{ name: string; matchIntent?: (m: string) => unknown }>)
        .filter((t) => typeof t.matchIntent === "function" && t.matchIntent(prompt) != null);
      expect(claimed).toHaveLength(0);
    },
  );
});
