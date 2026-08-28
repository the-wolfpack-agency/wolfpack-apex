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
  /* Raised from 25 to 30 on 2026-08-26 by the pilot_status tool. The status
     cluster was the last WHOLLY dead group in the audit: three prompts, no
     tool, because no tool existed. Measured 27 before and 30 after, on the
     same 36-prompt corpus. */
  /* Raised from 30 to 31 on 2026-08-28 by the capability-question shape.
     "can you send an email for me" reached no tool, went to a model, and was
     answered "I cannot send emails directly" - false, and produced live minutes
     after the system prompt was rewritten to forbid exactly that. An
     instruction is not a control; a lookup against the registry is. */
  const FLOOR = 31;

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
    /* EMPTY, as of the pilot_status tool on 2026-08-26.
     *
     * This asserted ["status"] for one day. "what's blocking the pilot", "how
     * is the pilot going" and "what's left to do" reached no tool because no
     * tool existed, and it is the question a client asks first. The entry came
     * out in the same change that made it untrue, which is what this list is
     * for: a dead cluster is a missing capability, and it is meant to be
     * argued with until somebody builds the thing.
     *
     * Still an assertion rather than a deletion, because the next capability
     * gap should fail here rather than be discovered by a client. */
    expect(dead).toEqual([]);
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
    /* The status cluster. Every one of these reached nothing at all until the
       tool existed, and they are the three sentences the audit measured. */
    ["what's blocking the pilot", "pilot_status"],
    ["how is the pilot going", "pilot_status"],
    ["what's left to do", "pilot_status"],
    /* The phrasings a client uses for the same question, which is the point of
       having a tool rather than a keyword. */
    ["where are we on the project", "pilot_status"],
    ["are we on track", "pilot_status"],
    ["how are we tracking", "pilot_status"],
    ["what's at risk", "pilot_status"],
    ["give me a status update on the engagement", "pilot_status"],
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

/**
 * The boundary between "how is the engagement going" and "what is on my plate".
 *
 * pilot_status and task_list_widget both answer a question about outstanding
 * work, and the difference is scope, not vocabulary: a personal to-do question
 * belongs to the task list, an engagement question belongs to status. A widened
 * matcher on either side turns one of them into a tool that confidently answers
 * a question that was not for it, which the audit rates as worse than reaching
 * nothing.
 *
 * Pinned in both directions so neither can drift into the other.
 */
describe("pilot_status does not trespass on the personal task list", () => {
  async function claimants(prompt: string): Promise<string[]> {
    await import("@/lib/assistant/tools");
    const { getTools } = await import("@/lib/assistant/tools/registry");
    return (getTools() as unknown as Array<{ name: string; matchIntent?: (m: string) => unknown }>)
      .filter((t) => typeof t.matchIntent === "function" && t.matchIntent(prompt) != null)
      .map((t) => t.name);
  }

  /* These are somebody's own to-do list, not a question about an engagement. */
  it.each([
    "what are my tasks",
    "anything overdue",
    "what's on my plate",
    "what have I got outstanding",
    "my tasks",
  ])("%s stays with the task list", async (prompt) => {
    const got = await claimants(prompt);
    expect(got).not.toContain("pilot_status");
  });

  /* And the engagement questions must reach exactly one tool, not two. A
     second claimant is how a prompt stops counting in the audit even though
     both tools "work". */
  it.each([
    "what's blocking the pilot",
    "how is the pilot going",
    "what's left to do",
    "where do we stand",
  ])("%s reaches pilot_status and nothing else", async (prompt) => {
    expect(await claimants(prompt)).toEqual(["pilot_status"]);
  });
});
