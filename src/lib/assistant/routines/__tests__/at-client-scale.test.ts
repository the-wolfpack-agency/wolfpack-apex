/**
 * What a chain does when the data is a client's rather than ours.
 *
 * Everything else in this suite runs against the shape of our own tenancy: an
 * empty mailbox, no deals, a handful of records. That is the shape nothing
 * breaks at, and it is not the shape we are about to be plugged into.
 *
 * The failure being guarded is not slowness. It is a prompt that grows with
 * somebody's data until a provider silently truncates it, after which the model
 * reasons over a fragment and answers with complete confidence. A wrong number
 * delivered calmly is the worst thing this product can do, and volume is the
 * likeliest way to get one.
 */
import { advance, startRun, type RunnerDeps } from "../runner";
import type { Routine } from "../types";

const WHO = { runId: "r", userId: "u", workspaceId: "w" };

/** A CRM's worth of records, not a fixture's worth. */
function manyDeals(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `deal-${i}`,
    name: `Account ${i}`,
    stage: i % 3 === 0 ? "negotiation" : "qualified",
    value: 10_000 + i,
    notes: "a paragraph of context that real records carry ".repeat(4),
  }));
}

const gatheringChain = (slots: number): Routine => ({
  id: "big",
  command: "big",
  description: "d",
  audience: "anyone",
  steps: [
    ...Array.from({ length: slots }, (_, i) => ({
      kind: "tool" as const,
      tool: `source_${i}`,
      slot: `source_${i}`,
      params: {},
      label: `Gathering ${i}`,
    })),
    {
      kind: "model" as const,
      slot: "sense",
      prompt: [
        ...Array.from({ length: slots }, (_, i) => `Source ${i}: {{source_${i}}}`),
        "",
        "Read those together and say what matters.",
      ].join("\n"),
      label: "Reading it together",
    },
  ],
});

function depsCapturing(capture: string[], payload: unknown): RunnerDeps {
  return {
    dispatchTool: async () => ({ ok: true, data: payload }),
    askModel: async (prompt) => {
      capture.push(prompt);
      return "an answer";
    },
    now: () => 0,
  };
}

describe("one tool returning a client's whole CRM", () => {
  it("does not put five hundred records into the prompt", async () => {
    const prompts: string[] = [];
    const r = gatheringChain(1);
    await advance(r, startRun(r, WHO), depsCapturing(prompts, manyDeals(500)));

    expect(prompts).toHaveLength(1);
    /* Bounded, and by a wide margin: the point is that it does not scale with
       the customer's data at all. */
    expect(prompts[0].length).toBeLessThan(6_000);
  });

  it("tells the model the list is partial, which is the part that matters", async () => {
    /* Silently shortened is the dangerous version: the model cannot tell, so
       it describes a fragment as the whole and nobody reading the answer
       knows. */
    const prompts: string[] = [];
    const r = gatheringChain(1);
    await advance(r, startRun(r, WHO), depsCapturing(prompts, manyDeals(500)));

    expect(prompts[0]).toMatch(/showing the first \d+ of 500/);
  });

  it("still completes rather than failing on size", async () => {
    /* A chain that refuses at volume is a chain that works in a demo and not
       at a client. */
    const prompts: string[] = [];
    const r = gatheringChain(1);
    const run = await advance(r, startRun(r, WHO), depsCapturing(prompts, manyDeals(2_000)));

    expect(run.state).toBe("done");
  });

  it("keeps whole records rather than cutting one in half", async () => {
    /* A record ending mid-field is worse than a shorter list: it reads as
       corrupt data rather than as a subset. */
    const prompts: string[] = [];
    const r = gatheringChain(1);
    await advance(r, startRun(r, WHO), depsCapturing(prompts, manyDeals(500)));

    const body = prompts[0].slice(0, prompts[0].indexOf("[showing the first"));
    /* Keyed on a field a reader keeps, not the id: a model step now strips
       plumbing (ids, cache status) so a brief cannot narrate "deal-0". The
       record itself still survives whole, which is what this test is about. */
    expect(body).toContain("Account 0");
    /* The kept portion parses back, so no record was severed. */
    const json = body.slice(body.indexOf("["), body.lastIndexOf("]") + 1);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("many tools each returning a reasonable share", () => {
  it("is bounded overall, not just per source", async () => {
    /* The gap the per-slot bound left: eight sources each individually
       sensible still assemble into something enormous, and nothing in between
       was counting. */
    const prompts: string[] = [];
    const r = gatheringChain(8);
    await advance(r, startRun(r, WHO), depsCapturing(prompts, manyDeals(500)));

    expect(prompts).toHaveLength(1);
    expect(prompts[0].length).toBeLessThan(40_000);
  });

  it("does not grow with the number of records behind each source", async () => {
    /* The property worth having: prompt size is a function of the CHAIN, not
       of the customer. */
    const small: string[] = [];
    const large: string[] = [];
    const r = gatheringChain(4);
    await advance(r, startRun(r, WHO), depsCapturing(small, manyDeals(30)));
    await advance(r, startRun(r, WHO), depsCapturing(large, manyDeals(5_000)));

    /* Same order of magnitude: the difference is the truncation notes, not the
       data. */
    expect(large[0].length).toBeLessThan(small[0].length * 2);
  });
});
