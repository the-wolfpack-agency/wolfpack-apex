/**
 * Changing a chain without describing the whole day again.
 *
 * THE INVARIANT THIS FILE PROTECTS is step order: a later step reads what an
 * earlier one wrote. Break it and the chain does not fail at the edit, it fails
 * the next morning with a message about a missing slot, long after anybody
 * would connect the two.
 *
 * So the interesting tests are all refusals.
 */
import { removeStep, moveStep, replaceTool, describeSteps } from "../edit";
import type { Routine } from "../types";
import type { ToolDef } from "@/lib/assistant/tools/types";

const tool = (name: string, capability = "*"): ToolDef<unknown, unknown> =>
  ({
    name,
    description: `Do the ${name} thing.`,
    capability,
    paramSchema: { safeParse: () => ({ success: true, data: {} }) },
    handler: async () => ({ ok: true, data: {}, answer: "" }),
  }) as unknown as ToolDef<unknown, unknown>;

const TOOLS = [tool("read_mail"), tool("read_calendar"), tool("finance", "cto")];

const chain = (): Routine => ({
  id: "r",
  command: "run my day",
  description: "d",
  audience: "anyone",
  steps: [
    { kind: "tool", slot: "mail", tool: "read_mail", params: {}, label: "Read the mail" },
    { kind: "tool", tool: "read_calendar", params: {}, label: "Read the calendar" },
    { kind: "model", prompt: "summarize {{mail}}", label: "Summarize it" },
    { kind: "human", label: "Decide what matters", action: "review" },
  ],
});

describe("removing a step", () => {
  it("removes the one the person pointed at, counting from one", () => {
    /* People say "drop step two". Off-by-one here removes the wrong step from
       somebody's morning. */
    const res = removeStep(chain(), 2);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.routine.steps).toHaveLength(3);
      expect(res.summary).toContain("Read the calendar");
      expect(JSON.stringify(res.routine)).not.toContain("read_calendar");
    }
  });

  it("REFUSES when a later step reads what that one produces", () => {
    /* Remove step one and the summary reads a slot nobody writes. The chain
       would fail tomorrow, not today. */
    const res = removeStep(chain(), 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/reads what that one produces \(mail\)/);
  });

  it("refuses to empty a routine", () => {
    /* A command that does nothing is worse than no command: it still appears
       in every list. */
    const single: Routine = { ...chain(), steps: [chain().steps[3]] };
    const res = removeStep(single, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/routine that does nothing/);
  });

  it("refuses a position that does not exist", () => {
    expect(removeStep(chain(), 9).ok).toBe(false);
    expect(removeStep(chain(), 0).ok).toBe(false);
  });

  it("leaves the original untouched", () => {
    const original = chain();
    const before = JSON.stringify(original);
    removeStep(original, 2);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("reordering", () => {
  it("moves a step where the person asked, counting from one", () => {
    /* People say "move the last one to the top". Off-by-one here reorders
       somebody's morning wrongly and they would not notice until it ran. */
    const res = moveStep(chain(), 4, 1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.routine.steps[0].label).toBe("Decide what matters");
      expect(res.routine.steps).toHaveLength(4);
      expect(res.summary).toContain("position 1");
    }
  });

  it("REFUSES an order that would read a slot before it is written", () => {
    /* Moving the summary above the mail step is the exact mistake somebody
       makes when tidying a list. */
    const res = moveStep(chain(), 3, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/before the one that produces what it reads \(mail\)/);
  });

  it("allows a move that keeps the order sound", () => {
    const res = moveStep(chain(), 2, 1);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.routine.steps[0].label).toBe("Read the calendar");
  });

  it("refuses a no-op and an impossible position", () => {
    expect(moveStep(chain(), 2, 2).ok).toBe(false);
    expect(moveStep(chain(), 2, 99).ok).toBe(false);
  });
});

describe("replacing the tool a step calls", () => {
  it("swaps the tool and keeps the label the person wrote", () => {
    /* The label is what they said about their own work and is still true. */
    const res = replaceTool(chain(), 2, "read_mail", TOOLS, "cto");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.routine.steps[1]).toMatchObject({ tool: "read_mail", label: "Read the calendar" });
    }
  });

  it("drops the old parameters rather than carrying a guess across", () => {
    /* They belonged to the OLD tool's schema. Moving them to the new one is a
       guess dressed as continuity, and it fails validation one run later with
       a message about the wrong thing. */
    const withParams: Routine = {
      ...chain(),
      steps: [
        chain().steps[0],
        { kind: "tool", tool: "read_calendar", params: { month: "current" }, label: "Read the calendar" },
        ...chain().steps.slice(2),
      ],
    };
    const res = replaceTool(withParams, 2, "read_mail", TOOLS, "cto");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.routine.steps[1]).toMatchObject({ tool: "read_mail", params: {} });
    }
  });

  it("refuses a tool that does not exist", () => {
    const res = replaceTool(chain(), 2, "imaginary", TOOLS, "cto");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not something I can run/i);
  });

  it("refuses a tool this person's role cannot run", () => {
    const res = replaceTool(chain(), 2, "finance", TOOLS, "sales");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/can no longer run/i);
  });

  it("refuses on a step that does not call a tool", () => {
    const res = replaceTool(chain(), 4, "read_mail", TOOLS, "cto");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does not call a tool/);
  });
});

describe("showing somebody their own chain", () => {
  it("numbers the steps the way they will refer to them", () => {
    const text = describeSteps(chain());
    expect(text).toMatch(/^1\. \*\*Read the mail\*\* \(read_mail\)/m);
    expect(text).toMatch(/^4\. \*\*Decide what matters\*\* \(yours\)/m);
  });

  it("marks a thinking step as thinking, not as a tool", () => {
    expect(describeSteps(chain())).toMatch(/\(thinking\)/);
  });
});
