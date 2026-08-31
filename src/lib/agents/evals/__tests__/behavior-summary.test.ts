/**
 * Turning behavior scores into a sentence someone can act on.
 *
 * The tests that matter are about the middle verdict. This summary is read by
 * the person deciding whether an agent gets near a client system, and if
 * "unproven" renders as a soft pass, they will read "we never checked" as "we
 * checked and it was fine". That is the confusion this whole family of features
 * exists to prevent, so it is pinned here rather than left to the template.
 */
jest.mock("@/lib/db", () => ({ query: jest.fn() }));

import { summarizeRows, describeBehavior, orderKinds, getFleetBehavior } from "../behavior-summary";
import { query } from "@/lib/db";

const q = query as jest.Mock;

function row(over: Record<string, unknown> = {}) {
  return {
    agent_id: "a1",
    containment: "pass",
    honesty: "unproven",
    finding_kinds: "none",
    timestamp: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  q.mockReset();
});

describe("an agent that has never been scored", () => {
  it("is UNKNOWN, not good", () => {
    // Zero runs is an absence of evidence. Rendering it as clean would make a
    // brand-new agent look as trustworthy as a proven one.
    const [s] = summarizeRows([]).length ? summarizeRows([]) : [undefined];
    expect(s).toBeUndefined();

    const described = describeBehavior({
      agentId: "a1",
      runs: 0,
      containment: { pass: 0, fail: 0, unproven: 0 },
      honesty: { pass: 0, fail: 0, unproven: 0 },
      findingKinds: [],
      lastScoredAt: null,
    });
    expect(described.standing).toBe("unknown");
    expect(described.headline).toMatch(/nothing to judge it on/);
  });
});

describe("the middle verdict", () => {
  it("is never reported as a clean bill of health", () => {
    // Every run passed containment and honesty was unproven, which is the
    // normal state today. It must not read as "all good".
    const [s] = summarizeRows([row(), row()]);
    expect(s.standing).toBe("unknown");
    expect(s.headline).toMatch(/not a clean bill of health/);
    expect(s.headline).not.toMatch(/^Stayed inside its limits/);
  });

  it("says plainly what has NOT been established", () => {
    const [s] = summarizeRows([row()]);
    expect(s.headline).toMatch(/have not yet proved its limits hold/);
  });

  it("reports good only when nothing at all is unproven", () => {
    const [s] = summarizeRows([row({ honesty: "pass" })]);
    expect(s.standing).toBe("good");
    expect(s.headline).toMatch(/account matched the record every time/);
  });
});

describe("what should worry someone most", () => {
  it("leads with escaping a boundary, above everything else", () => {
    const [s] = summarizeRows([
      row({ containment: "fail", honesty: "fail", finding_kinds: "egress-succeeded,concealed-failure" }),
    ]);
    expect(s.standing).toBe("attention");
    expect(s.headline).toMatch(/Reached something it was not allowed to reach/);
    expect(s.headline).toMatch(/before giving it more access/);
  });

  it("reports a mismatched account when containment held", () => {
    const [s] = summarizeRows([row({ containment: "pass", honesty: "fail", finding_kinds: "concealed-failure" })]);
    expect(s.headline).toMatch(/did not match what it actually did/);
  });

  it("surfaces a REFUSED attempt even though the boundary held", () => {
    // The boundary worked, so this is not a failure. It is still the most
    // interesting thing in the record, and burying it under a green tick is how
    // the next escape goes unnoticed.
    const [s] = summarizeRows([row({ containment: "pass", honesty: "pass", finding_kinds: "egress-attempt" })]);
    expect(s.standing).toBe("attention");
    expect(s.headline).toMatch(/tried to reach outside them and was stopped/);
  });

  it("counts how many runs went wrong, not just that some did", () => {
    const [s] = summarizeRows([row({ containment: "fail" }), row(), row()]);
    expect(s.headline).toMatch(/on 1 of 3 runs/);
  });
});

describe("summarizeRows", () => {
  it("groups by agent and keeps the most recent scoring time", () => {
    const out = summarizeRows([
      row({ agent_id: "a1", timestamp: "2026-08-01T10:00:00.000Z" }),
      row({ agent_id: "a1", timestamp: "2026-08-02T09:00:00.000Z" }),
      row({ agent_id: "a2" }),
    ]);
    expect(out.map((s) => s.agentId).sort()).toEqual(["a1", "a2"]);
    expect(out.find((s) => s.agentId === "a1")?.lastScoredAt).toBe("2026-08-02T09:00:00.000Z");
    expect(out.find((s) => s.agentId === "a1")?.runs).toBe(2);
  });

  it("sorts the worst first, because this list exists to be acted on", () => {
    const out = summarizeRows([
      row({ agent_id: "clean", honesty: "pass" }),
      row({ agent_id: "escaped", containment: "fail" }),
      row({ agent_id: "unproven-only" }),
    ]);
    expect(out.map((s) => s.agentId)).toEqual(["escaped", "unproven-only", "clean"]);
  });

  it("ignores the literal 'none' placeholder rather than counting it as a finding", () => {
    const [s] = summarizeRows([row({ finding_kinds: "none" })]);
    expect(s.findingKinds).toEqual([]);
  });

  it("drops a row with no agent id instead of inventing one", () => {
    expect(summarizeRows([row({ agent_id: null })])).toEqual([]);
  });

  it("ignores a verdict it does not recognize rather than miscounting it", () => {
    // A future verdict name must not silently land in the pass column.
    const [s] = summarizeRows([row({ containment: "sideways" })]);
    expect(s.containment).toEqual({ pass: 0, fail: 0, unproven: 0 });
    expect(s.runs).toBe(1);
  });
});

describe("orderKinds", () => {
  it("puts the most serious first, so a truncated list still leads with what matters", () => {
    expect(orderKinds(["boundary-unproven", "egress-succeeded", "concealed-failure"])).toEqual([
      "egress-succeeded",
      "concealed-failure",
      "boundary-unproven",
    ]);
  });

  it("deduplicates", () => {
    expect(orderKinds(["egress-attempt", "egress-attempt"])).toEqual(["egress-attempt"]);
  });

  it("keeps an unrecognized kind rather than dropping it, at the end", () => {
    expect(orderKinds(["something-new", "egress-succeeded"])).toEqual(["egress-succeeded", "something-new"]);
  });
});

describe("getFleetBehavior", () => {
  const ORIGINAL = process.env.DATABASE_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL;
  });

  it("returns an empty list rather than throwing when analytics cannot be read", async () => {
    // A panel must not be able to take down the fleet page. The UI renders
    // "not scored yet", which is honest: we genuinely do not know.
    process.env.DATABASE_URL = "postgres://x";
    q.mockRejectedValue(new Error("db down"));
    await expect(getFleetBehavior()).resolves.toEqual([]);
  });

  it("reads only behavior events, within the window", async () => {
    process.env.DATABASE_URL = "postgres://x";
    q.mockResolvedValue({ rows: [] });
    await getFleetBehavior(14);
    expect(q.mock.calls[0][0]).toContain("agent.behavior_scored");
    expect(q.mock.calls[0][1]).toEqual([14]);
  });

  it("does not query at all with no database configured", async () => {
    delete process.env.DATABASE_URL;
    await expect(getFleetBehavior()).resolves.toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });
});
