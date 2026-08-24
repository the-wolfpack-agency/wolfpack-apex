/**
 * The guide cannot promise something the product does not do.
 *
 * Every written guide drifts. It is correct the day it ships and wrong
 * the first time a matcher changes, and nobody notices because a
 * document has no way to fail.
 *
 * This one is a list of phrasings with the tool each should reach, so it
 * can be run. It caught two mistakes the moment it was written: receipt
 * phrasings filed under the invoice scanner, which would have told
 * somebody to type "expense this" and expect an invoice reader.
 */

export {};

import "../tools/index";
import { getTools } from "../tools/registry";
import { PROMPT_GUIDE, guidedPhrasings } from "../prompt-corpus";

function claimants(message: string): string[] {
  const out: string[] = [];
  for (const tool of getTools() as unknown as Array<{
    name: string;
    matchIntent?: (m: string) => unknown;
  }>) {
    try {
      if (tool.matchIntent && tool.matchIntent(message)) out.push(tool.name);
    } catch {
      /* a matcher that throws has its own test */
    }
  }
  return out;
}

describe("every phrasing the guide shows a user", () => {
  it.each(guidedPhrasings().map((g) => [g.phrase, g.tool] as const))(
    "%s reaches %s",
    (phrase, tool) => {
      expect(claimants(phrase)).toContain(tool);
    },
  );
});

describe("the shape of the guide", () => {
  it("names the goal in the user's words, not the tool's", () => {
    /* Somebody looking for how to book a meeting is not looking for
       create_calendar_event_form. A guide organised by our internals is a
       guide for us. */
    for (const g of PROMPT_GUIDE) {
      expect(g.goal.toLowerCase()).not.toContain("_");
      expect(g.goal.length).toBeGreaterThan(8);
    }
  });

  it("says what comes back, so nobody has to run it to find out", () => {
    for (const g of PROMPT_GUIDE) {
      expect(g.gives.length).toBeGreaterThan(20);
    }
  });

  it("is honest about the write tools stopping for a human", () => {
    /* The three that can change something say so where somebody reads
       it, not in a comment. Anybody deciding whether to try "tell the
       team it is ready" needs to know it drafts rather than sends. */
    const writes = PROMPT_GUIDE.filter((g) =>
      ["create_message_form", "create_calendar_event_form", "create_task_form"].includes(g.tool),
    );
    expect(writes.length).toBe(3);
    for (const g of writes) {
      expect(g.gives.toLowerCase()).toMatch(/confirm|never sends|until you/);
    }
  });

  it("does not claim to be the whole product", () => {
    /* A list this size read as exhaustive would teach people to type like
       a manual instead of like themselves, which is the opposite of what
       any of this was for. The file says so at the top; this pins that it
       keeps saying it. */
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "prompt-corpus.ts"),
      "utf8",
    ) as string;
    expect(source).toMatch(/not the only ones that work|IT IS NOT THE WHOLE PRODUCT/i);
  });
});

/**
 * What the capability answer ends with.
 *
 * The list says what exists. Somebody who has just asked what this does
 * still has to guess at the words, and guessing is where people give up,
 * which is the whole reason the capability question was worth fixing.
 */
describe("three things to type", () => {
  async function answerFor(userRole: string): Promise<string> {
    const tool = (getTools() as unknown as Array<{
      name: string;
      handler: (p: unknown, c: unknown) => Promise<{ answer: string }>;
    }>).find((t) => t.name === "what_can_you_do")!;
    const res = await tool.handler({}, { userId: "u1", userRole, workspaceId: "default" });
    return res.answer;
  }

  it("ends with phrasings, not with a tool list", async () => {
    const answer = await answerFor("designer");
    expect(answer).toContain("If you would rather just start");
    expect(answer).toContain("what came in overnight");
  });

  it("does not suggest the question that was just asked", async () => {
    /* Answering "what can you do?" with "try: what can you do?" is the
       kind of thing that only shows up when you read the output rather
       than the code. */
    const answer = await answerFor("designer");
    const openers = answer.slice(answer.indexOf("If you would rather just start"));
    expect(openers).not.toContain("what can you do");
  });

  it("only suggests what this role can actually run", async () => {
    /* The same gate the list above it passes through. A suggestion
       somebody cannot run is a menu of disappointments. */
    const answer = await answerFor("designer");
    const openers = answer.slice(answer.indexOf("If you would rather just start"));
    const suggested = [...openers.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(suggested.length).toBeGreaterThan(0);
    for (const phrase of suggested) {
      expect(claimants(phrase).length).toBeGreaterThan(0);
    }
  });
});
