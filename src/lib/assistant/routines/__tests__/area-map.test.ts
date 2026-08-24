/**
 * Where one area's work touches another's.
 *
 * A list of chains says what somebody can run. It does not say how their
 * work reaches anybody else's, which is the question a company asks
 * before it buys middleware: not "can this automate my morning" but "does
 * automating my morning help the person after me".
 *
 * Every area, chain and crossing is DERIVED from the templates: the
 * audience each declares and the tools its steps actually run. A map of
 * how a business should flow is a diagram anybody can draw in an
 * afternoon and nobody can check. This one is only ever a picture of what
 * is built.
 */

export {};

import { buildAreaMap, describeAreaMap } from "../area-map";

type T = Parameters<typeof buildAreaMap>[0] extends readonly (infer U)[] ? U : never;

function template(over: Partial<Record<string, unknown>>): T {
  return {
    id: "t",
    command: "c",
    description: "d",
    audience: "anyone",
    forRole: "Anyone",
    outcome: "o",
    steps: [],
    ...over,
  } as unknown as T;
}

describe("the map is built from what exists", () => {
  it("groups chains by the area each declares", () => {
    const map = buildAreaMap([
      template({ command: "check the pipeline", audience: "sales", forRole: "Sales" }),
      template({ command: "work the pipeline", audience: "sales", forRole: "Sales" }),
      template({ command: "check the numbers", audience: "leadership", forRole: "Leadership" }),
    ]);
    expect(map.areas.map((a) => a.area)).toEqual(["sales", "leadership"]);
    expect(map.areas[0].chains).toHaveLength(2);
  });

  it("records which systems a chain touches, deduped and in order", () => {
    const map = buildAreaMap([
      template({
        steps: [
          { kind: "tool", tool: "calendar_widget", label: "a", slot: "x", params: {} },
          { kind: "tool", tool: "calendar_widget", label: "b", slot: "y", params: {} },
          { kind: "tool", tool: "task_list_widget", label: "c", slot: "z", params: {} },
          { kind: "human", label: "decide", action: "do" },
        ],
      }),
    ]);
    expect(map.areas[0].chains[0].touches).toEqual(["calendar_widget", "task_list_widget"]);
    expect(map.areas[0].chains[0].humanSteps).toBe(1);
  });
});

describe("a crossing is two areas meeting, not one area repeating itself", () => {
  it("reports a system reached from more than one area", () => {
    const map = buildAreaMap([
      template({
        command: "start my day",
        audience: "anyone",
        steps: [{ kind: "tool", tool: "email_thread_widget", label: "a", slot: "x", params: {} }],
      }),
      template({
        command: "work the pipeline",
        audience: "sales",
        steps: [{ kind: "tool", tool: "email_thread_widget", label: "b", slot: "y", params: {} }],
      }),
    ]);
    expect(map.crossings).toHaveLength(1);
    expect(map.crossings[0]).toMatchObject({
      tool: "email_thread_widget",
      areas: ["anyone", "sales"],
    });
    /* The chains are named so a claim can be checked rather than
       believed. */
    expect(map.crossings[0].chains).toEqual(["start my day", "work the pipeline"]);
  });

  it("does not call two chains in the SAME area a crossing", () => {
    /* Two sales chains both reading the pipeline is sales doing its job,
       not two parts of a company meeting. Counting it would inflate every
       map and make the real crossings harder to see. */
    const map = buildAreaMap([
      template({ command: "a", audience: "sales", steps: [{ kind: "tool", tool: "crm", label: "x", slot: "s", params: {} }] }),
      template({ command: "b", audience: "sales", steps: [{ kind: "tool", tool: "crm", label: "y", slot: "t", params: {} }] }),
    ]);
    expect(map.crossings).toEqual([]);
  });

  it("puts the most-shared system first", () => {
    /* The systems more of the company depends on are the ones worth
       connecting first, and worth worrying about when they are down. */
    const map = buildAreaMap([
      template({ command: "a", audience: "anyone", steps: [{ kind: "tool", tool: "shared", label: "1", slot: "a", params: {} }, { kind: "tool", tool: "pair", label: "2", slot: "b", params: {} }] }),
      template({ command: "b", audience: "sales", steps: [{ kind: "tool", tool: "shared", label: "3", slot: "c", params: {} }, { kind: "tool", tool: "pair", label: "4", slot: "d", params: {} }] }),
      template({ command: "c", audience: "engineer", steps: [{ kind: "tool", tool: "shared", label: "5", slot: "e", params: {} }] }),
    ]);
    expect(map.crossings[0].tool).toBe("shared");
    expect(map.crossings[0].areas).toHaveLength(3);
  });
});

describe("what it says when the map is thin", () => {
  it("says there is nothing rather than drawing an empty company", () => {
    expect(describeAreaMap(buildAreaMap([]))).toContain("nothing to map");
  });

  it("says plainly when no area's work reaches another's", () => {
    /* The honest answer for a young catalogue. A summary that described
       three unconnected chains as a company's flow would be the same
       overclaim as a coverage report calling a failed walk a mapped
       system. */
    const map = buildAreaMap([
      template({ command: "a", audience: "sales", steps: [{ kind: "tool", tool: "one", label: "x", slot: "s", params: {} }] }),
      template({ command: "b", audience: "engineer", steps: [{ kind: "tool", tool: "two", label: "y", slot: "t", params: {} }] }),
    ]);
    expect(describeAreaMap(map)).toContain("None of them touch the same system");
  });

  it("names the most-shared system when there is one", () => {
    expect(describeAreaMap(buildAreaMap())).toMatch(/most shared being \w+/);
  });
});
