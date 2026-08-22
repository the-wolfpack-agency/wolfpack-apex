/**
 * Keeping a chain working, and knowing when it is not.
 *
 * The dangerous move in this file is a confident repair. A workflow somebody
 * relies on every morning, quietly rewired to a tool that does something
 * adjacent, is worse than one that visibly broke: it keeps running, keeps
 * reporting success, and stops doing what they think it does.
 *
 * So most of these tests are about the repair being REFUSED.
 */
import {
  checkRoutine,
  readRepair,
  applyRepairs,
  describeRepairs,
  buildRepairPrompt,
} from "../heal";
import type { Routine } from "../types";
import type { ToolDef } from "@/lib/assistant/tools/types";

const tool = (name: string, capability = "*", accepts: string[] = []): ToolDef<unknown, unknown> =>
  ({
    name,
    description: `Do the ${name} thing. Second sentence.`,
    capability,
    paramSchema: {
      safeParse: (v: unknown) => {
        const keys = Object.keys((v ?? {}) as Record<string, unknown>);
        const ok = keys.every((k) => accepts.includes(k));
        return ok ? { success: true, data: v } : { success: false, error: { issues: [] } };
      },
    },
    handler: async () => ({ ok: true, data: {}, answer: "" }),
  }) as unknown as ToolDef<unknown, unknown>;

const TOOLS = [tool("search_mail", "*", ["topic"]), tool("read_inbox"), tool("finance", "cto")];

const routine = (steps: Routine["steps"]): Routine => ({
  id: "r",
  command: "run my day",
  description: "d",
  audience: "anyone",
  steps,
});

describe("checking that a routine still does what it says", () => {
  it("passes a routine whose steps all still resolve", () => {
    const r = routine([{ kind: "tool", tool: "read_inbox", params: {}, label: "Read the inbox" }]);
    expect(checkRoutine(r, TOOLS, "cto")).toEqual({ ok: true, problems: [] });
  });

  it("finds a tool that no longer exists", () => {
    const r = routine([{ kind: "tool", tool: "gone_tool", params: {}, label: "Do the old thing" }]);
    const health = checkRoutine(r, TOOLS, "cto");
    expect(health.ok).toBe(false);
    expect(health.problems[0]).toMatchObject({ kind: "tool_missing", stepIndex: 0 });
  });

  it("finds a step this person may no longer run", () => {
    /* A role change silently breaking somebody's morning is exactly the class
       of failure this check exists to catch before 8am. */
    const r = routine([{ kind: "tool", tool: "finance", params: {}, label: "Read revenue" }]);
    expect(checkRoutine(r, TOOLS, "sales").problems[0]).toMatchObject({ kind: "not_permitted" });
    expect(checkRoutine(r, TOOLS, "cto").ok).toBe(true);
  });

  it("finds parameters a tool no longer accepts", () => {
    const r = routine([
      { kind: "tool", tool: "search_mail", params: { removed_field: 1 }, label: "Search mail" },
    ]);
    expect(checkRoutine(r, TOOLS, "cto").problems[0]).toMatchObject({ kind: "params_invalid" });
  });

  it("does not validate parameters that are still placeholders", () => {
    /* "{{inbox}}" is filled at run time. Validating it now would report a
       problem that only exists on paper, and a health check that cries wolf is
       one nobody reads. */
    const r = routine([
      { kind: "tool", tool: "search_mail", params: { topic: "{{inbox}}" }, label: "Search mail" },
    ]);
    expect(checkRoutine(r, TOOLS, "cto").ok).toBe(true);
  });

  it("ignores human and model steps, which cannot break this way", () => {
    const r = routine([
      { kind: "human", label: "Rehearse the opening", action: "do" },
      { kind: "model", prompt: "summarise", label: "Summarise it" },
    ]);
    expect(checkRoutine(r, TOOLS, "cto").ok).toBe(true);
  });

  it("reports every broken step, not just the first", () => {
    const r = routine([
      { kind: "tool", tool: "gone_one", params: {}, label: "One" },
      { kind: "tool", tool: "read_inbox", params: {}, label: "Two" },
      { kind: "tool", tool: "gone_two", params: {}, label: "Three" },
    ]);
    expect(checkRoutine(r, TOOLS, "cto").problems).toHaveLength(2);
  });
});

describe("reading a proposed repair", () => {
  const problem = {
    stepIndex: 0,
    label: "Read the inbox",
    kind: "tool_missing" as const,
    tool: "gone_tool",
    detail: "gone",
  };

  it("accepts a replacement that exists and the person can run", () => {
    const r = readRepair('{"tool":"read_inbox","reason":"same job"}', problem, TOOLS, "cto");
    expect(r).toMatchObject({ action: "replace_tool", tool: "read_inbox" });
  });

  it("REFUSES an invented tool and removes the step instead", () => {
    /* A confident repair to a tool that does not exist would break the chain a
       second time, in a way that now looks like our fix. */
    const r = readRepair('{"tool":"imaginary_tool"}', problem, TOOLS, "cto");
    expect(r.action).toBe("drop_step");
  });

  it("refuses a replacement the person's role cannot run", () => {
    const r = readRepair('{"tool":"finance"}', problem, TOOLS, "sales");
    expect(r.action).toBe("drop_step");
  });

  it("refuses the broken tool as its own replacement", () => {
    /* A model agreeing with the question rather than answering it. */
    const r = readRepair('{"tool":"gone_tool"}', problem, TOOLS, "cto");
    expect(r.action).toBe("drop_step");
  });

  it.each([[""], ["not json"], ["{}"], ['{"tool":null}'], ['{"tool":"null"}']])(
    "falls back to removing the step on unusable output (%p)",
    (raw) => {
      expect(readRepair(raw, problem, TOOLS, "cto").action).toBe("drop_step");
    },
  );

  it("carries a reason a person can weigh", () => {
    const r = readRepair('{"tool":"read_inbox","reason":"it reads the same mailbox"}', problem, TOOLS, "cto");
    expect(r.reason).toMatch(/same mailbox/);
  });
});

describe("what we ask the model", () => {
  const step = { kind: "tool" as const, tool: "gone_tool", params: {}, label: "Read the inbox" };
  const problem = { stepIndex: 0, label: "Read the inbox", kind: "tool_missing" as const, tool: "gone_tool", detail: "gone" };

  it("tells it an adjacent tool is worse than none, and why", () => {
    /* The failure being designed against: a workflow quietly rewired to
       something that does a similar-sounding job. */
    const prompt = buildRepairPrompt(problem, step, TOOLS);
    expect(prompt).toMatch(/does something adjacent is worse than none/i);
    expect(prompt).toMatch(/trusts this workflow to do what it says/i);
  });

  it("offers only real tools, and forbids inventing a name", () => {
    const prompt = buildRepairPrompt(problem, step, [tool("read_inbox")]);
    expect(prompt).toContain("read_inbox");
    expect(prompt).toMatch(/Never invent a name/i);
  });
});

describe("applying a repair", () => {
  const broken = routine([
    { kind: "tool", tool: "gone_tool", params: { old: 1 }, label: "Read the inbox" },
    { kind: "human", label: "Check it", action: "review" },
    { kind: "tool", tool: "read_inbox", params: {}, label: "Read again" },
  ]);

  it("returns a COPY, leaving the stored routine alone", () => {
    /* The stored version changes only when the owner has agreed. Holding the
       repaired one separately is what makes "here is what it would become"
       possible to show them. */
    const before = JSON.stringify(broken);
    applyRepairs(broken, [{ stepIndex: 0, action: "drop_step", reason: "gone" }]);
    expect(JSON.stringify(broken)).toBe(before);
  });

  it("replaces a tool and keeps the label the person wrote", () => {
    const fixed = applyRepairs(broken, [
      { stepIndex: 0, action: "replace_tool", tool: "read_inbox", reason: "same job" },
    ]);
    expect(fixed.steps[0]).toMatchObject({ tool: "read_inbox", label: "Read the inbox" });
  });

  it("drops the old parameters, which belonged to a different schema", () => {
    /* Carrying them across would be a guess dressed as continuity. */
    const fixed = applyRepairs(broken, [
      { stepIndex: 0, action: "replace_tool", tool: "read_inbox", reason: "r" },
    ]);
    expect((fixed.steps[0] as { params: unknown }).params).toEqual({});
  });

  it("removes a step when there is no replacement", () => {
    const fixed = applyRepairs(broken, [{ stepIndex: 0, action: "drop_step", reason: "gone" }]);
    expect(fixed.steps).toHaveLength(2);
    expect(fixed.steps[0].kind).toBe("human");
  });

  it("leaves untouched steps exactly as they were", () => {
    const fixed = applyRepairs(broken, [{ stepIndex: 0, action: "drop_step", reason: "gone" }]);
    expect(fixed.steps[1]).toEqual(broken.steps[2]);
  });
});

describe("asking the owner", () => {
  const broken = routine([
    { kind: "tool", tool: "gone_tool", params: {}, label: "Read the inbox" },
    { kind: "tool", tool: "read_inbox", params: {}, label: "Read again" },
  ]);

  it("says what would change and what would be left", () => {
    const text = describeRepairs(broken, [
      { stepIndex: 0, action: "replace_tool", tool: "read_inbox", reason: "same job" },
    ]);
    expect(text).toContain("Read the inbox");
    expect(text).toContain("read_inbox");
    expect(text).toMatch(/would leave 2 steps/i);
  });

  it("states the loss plainly when a step would be removed", () => {
    /* A shorter chain is a real loss, not a tidy-up, and somebody saying yes
       should know that is what they are agreeing to. */
    const text = describeRepairs(broken, [{ stepIndex: 0, action: "drop_step", reason: "nothing does that job" }]);
    expect(text).toMatch(/remove this step/i);
    expect(text).toMatch(/would leave 1 step/i);
  });

  it("makes clear that doing nothing is allowed", () => {
    const text = describeRepairs(broken, [{ stepIndex: 0, action: "drop_step", reason: "r" }]);
    expect(text).toMatch(/leave it and the routine stays as it is/i);
  });
});
