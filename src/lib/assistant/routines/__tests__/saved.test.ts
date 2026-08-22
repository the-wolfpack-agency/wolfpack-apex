/**
 * Chains people kept.
 *
 * Two things here can hurt somebody. Storing a command that shadows a built-in
 * means a documented instruction quietly starts doing something else. And
 * reading back a row written by an older deploy means running a shape the
 * runner no longer understands, on somebody's Monday morning.
 *
 * Both get refused rather than repaired.
 */
import { rowToRoutine, isReservedCommand, saveRoutine } from "../saved";
import { BUILT_IN_ROUTINES } from "../catalogue";

const steps = [
  { kind: "tool", tool: "search_mail", params: {}, label: "Read the overnight email" },
  { kind: "human", label: "Rehearse the opening", action: "do" },
];

const row = (over: Record<string, unknown> = {}) => ({
  id: "w:u:run my day",
  command: "run my day",
  description: "Saved from the day you described.",
  steps,
  ...over,
});

describe("commands nobody may take", () => {
  it.each(BUILT_IN_ROUTINES.map((r) => r.command))("refuses to shadow %p", (command) => {
    expect(isReservedCommand(command)).toBe(true);
  });

  it("allows anything else", () => {
    expect(isReservedCommand("run my day")).toBe(false);
  });

  it("refuses on save, with a reason the person can act on", async () => {
    const res = await saveRoutine(
      { workspaceId: "w", userId: "u" },
      { id: "x", command: "run my morning", description: "d", audience: "anyone", steps: steps as never },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/already one of the built-in routines/i);
  });

  it("refuses a command too short to be memorable", async () => {
    const res = await saveRoutine(
      { workspaceId: "w", userId: "u" },
      { id: "x", command: "go", description: "d", audience: "anyone", steps: steps as never },
    );
    expect(res.ok).toBe(false);
  });

  it("refuses a routine with a step it cannot run", async () => {
    const res = await saveRoutine(
      { workspaceId: "w", userId: "u" },
      {
        id: "x",
        command: "run my day",
        description: "d",
        audience: "anyone",
        steps: [{ kind: "wat", label: "?" }] as never,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not something I can run/i);
  });
});

describe("reading a stored routine back", () => {
  it("rebuilds one that is still good", () => {
    const r = rowToRoutine(row());
    expect(r?.command).toBe("run my day");
    expect(r?.steps).toHaveLength(2);
  });

  it("parses steps stored as a JSON string", () => {
    expect(rowToRoutine(row({ steps: JSON.stringify(steps) }))?.steps).toHaveLength(2);
  });

  it("REFUSES a routine with an unrecognised step rather than skipping it", () => {
    /* A chain silently missing its third step still runs, still reports
       success, and has quietly stopped doing part of somebody's job. */
    expect(rowToRoutine(row({ steps: [steps[0], { kind: "telepathy", label: "x" }] }))).toBeNull();
  });

  it("refuses a tool step with no tool name", () => {
    expect(rowToRoutine(row({ steps: [{ kind: "tool", params: {}, label: "x" }] }))).toBeNull();
  });

  it("refuses a step with no label, because the person would see a blank line", () => {
    expect(rowToRoutine(row({ steps: [{ kind: "human", label: "" }] }))).toBeNull();
  });

  it("accepts a human step from before the review/do distinction existed", () => {
    /* Rows written by an older deploy are a real case, and this one is still
       perfectly runnable. */
    expect(rowToRoutine(row({ steps: [{ kind: "human", label: "Check it" }] }))).not.toBeNull();
  });

  it.each([[null], [[]], ["not json"], [{}]])("refuses unusable steps (%p)", (bad) => {
    expect(rowToRoutine(row({ steps: bad }))).toBeNull();
  });
});
