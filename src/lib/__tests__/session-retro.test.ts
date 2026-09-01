/**
 * The retrospective's job is to be useful and fair. Useful means it names the
 * missing information rather than saying "be clearer". Fair means it never
 * bills the operator for a round the agent caused — that is the case these
 * tests spend the most effort on, because getting it wrong turns a learning
 * tool into a tool that blames the customer.
 */
import { analyzeRetro, recurringCauses, renderRetroSection, FRICTION_TAXONOMY, type RetroInput } from "../session-retro";

const retro = (over: Partial<RetroInput> = {}): RetroInput => ({
  ask: "add acceptance criteria to sites",
  rounds: 1,
  causes: [],
  ...over,
});

describe("analyzeRetro", () => {
  it("says nothing to change on a one-round session", () => {
    expect(analyzeRetro(retro()).headline).toBe("One round. Nothing to change.");
  });

  it("counts rounds better information would have removed", () => {
    const f = analyzeRetro(retro({ rounds: 3, causes: ["unstated-target", "unstated-done"] }));
    expect(f.avoidableRounds).toBe(2);
    expect(f.headline).toMatch(/2 avoidable/);
    expect(f.suggestions).toEqual(["Name the repo and branch in the first sentence.", "Say what you will check to decide it is done."]);
  });

  it("never blames the operator for a round the agent caused", () => {
    // The important one. A session that ran long because the agent shipped a
    // bug is not a prompting problem, and saying so would be both wrong and
    // rude.
    const f = analyzeRetro(retro({ rounds: 3, causes: ["agent-error", "agent-error"] }));
    expect(f.avoidableRounds).toBe(0);
    expect(f.agentRounds).toBe(2);
    expect(f.suggestions).toEqual([]);
    expect(f.headline).toMatch(/caused by the agent/);
    expect(f.headline).toMatch(/guardrails/);
  });

  it("treats discovery as value, not waste", () => {
    // Rounds spent because the codebase turned out to be different are the
    // good kind. Counting them as failures would train an operator to
    // over-specify and stop the discovery.
    const f = analyzeRetro(retro({ rounds: 3, causes: ["scope-discovered", "scope-discovered"] }));
    expect(f.avoidableRounds).toBe(0);
    expect(f.discoveryRounds).toBe(2);
    expect(f.headline).toMatch(/the extra rounds were the value/i);
  });

  it("separates the three kinds in one mixed session", () => {
    const f = analyzeRetro(retro({ rounds: 4, causes: ["unstated-target", "scope-discovered", "agent-error"] }));
    expect(f).toMatchObject({ avoidableRounds: 1, discoveryRounds: 1, agentRounds: 1 });
  });

  it("deduplicates suggestions and orders them stably", () => {
    // The same list every time is what lets an operator recognize a pattern
    // rather than re-read it.
    const a = analyzeRetro(retro({ rounds: 4, causes: ["unstated-done", "unstated-target", "unstated-target"] }));
    const b = analyzeRetro(retro({ rounds: 4, causes: ["unstated-target", "unstated-done"] }));
    expect(a.suggestions).toEqual(b.suggestions);
    expect(a.suggestions).toHaveLength(2);
  });

  it("every taxonomy entry carries an actionable ask, or is explicitly not the operator's to fix", () => {
    for (const e of FRICTION_TAXONOMY) {
      expect(e.ask.length).toBeGreaterThan(10);
      if (e.agentFault) expect(e.ask).toMatch(/on the agent|guardrail/i);
    }
  });
});

describe("recurringCauses", () => {
  it("surfaces only what repeats, because one session is not a habit", () => {
    const history = [
      retro({ causes: ["unstated-target"] }),
      retro({ causes: ["unstated-target", "unstated-done"] }),
      retro({ causes: ["assumed-context"] }),
    ];
    expect(recurringCauses(history)).toEqual([
      { cause: "unstated-target", count: 2, ask: "Name the repo and branch in the first sentence." },
    ]);
  });

  it("counts a cause once per session, not once per round", () => {
    // One missing fact that cost three rounds is one habit to change.
    const history = [retro({ causes: ["unstated-target", "unstated-target", "unstated-target"] })];
    expect(recurringCauses(history, 1)).toEqual([
      { cause: "unstated-target", count: 1, ask: "Name the repo and branch in the first sentence." },
    ]);
  });

  it("never surfaces agent error as an operator habit", () => {
    const history = [retro({ causes: ["agent-error"] }), retro({ causes: ["agent-error"] })];
    expect(recurringCauses(history)).toEqual([]);
  });

  it("is empty on a clean history", () => {
    expect(recurringCauses([retro(), retro()])).toEqual([]);
  });
});

describe("renderRetroSection", () => {
  it("writes the ask, the verdict and the concrete suggestions", () => {
    const input = retro({ rounds: 3, causes: ["unstated-target"], betterAsk: "In wolfpack-apex on a branch off main, add X. Done = verify.sh green." });
    const out = renderRetroSection(input, analyzeRetro(input));
    expect(out).toContain("## Prompt retrospective");
    expect(out).toContain("Name the repo and branch in the first sentence.");
    expect(out).toContain("> In wolfpack-apex on a branch off main");
  });

  it("states plainly when the rounds were the agent's fault", () => {
    const input = retro({ rounds: 2, causes: ["agent-error"] });
    const out = renderRetroSection(input, analyzeRetro(input));
    expect(out).toContain("Not the operator's to fix");
    expect(out).not.toContain("What would have collapsed the rounds");
  });
});
