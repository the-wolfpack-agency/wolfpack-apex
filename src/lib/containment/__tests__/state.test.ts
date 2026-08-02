/**
 * Reading the stop and the ledger.
 *
 * Every test here is about the difference between "the answer is no" and "we
 * could not get an answer". decideStep treats both as stop, but they are
 * different facts and the read layer must not collapse them: one is a person's
 * decision, the other is a broken database, and only one of them should page
 * someone.
 */
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  readContainmentState,
  readRunSpend,
  setAgentsEnabled,
  addRunSpend,
  _setContainmentStateForTests,
  _setRunSpendForTests,
} from "../state";
import { decideStep, DEFAULT_BUDGET } from "../budget";

const q = safeQuery as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  _setContainmentStateForTests(null);
  _setRunSpendForTests(null);
});

describe("readContainmentState", () => {
  it("reports enabled when the row says so", async () => {
    q.mockResolvedValue({ rows: [{ agents_enabled: true }] });
    expect(await readContainmentState("ws")).toEqual({ agentsEnabled: true, readable: true });
  });

  it("reports stopped when the row says so, and marks it READABLE", async () => {
    // A deliberate stop is a successful read of a "no". Reporting it as
    // unreadable would make a person's decision look like an outage.
    q.mockResolvedValue({ rows: [{ agents_enabled: false }] });
    expect(await readContainmentState("ws")).toEqual({ agentsEnabled: false, readable: true });
  });

  it("treats a MISSING row as unreadable, not as permission", async () => {
    // Migration 227 inserts the default workspace explicitly for this reason.
    // Absence and permission are different, and only one is safe to assume.
    q.mockResolvedValue({ rows: [] });
    expect(await readContainmentState("ws")).toEqual({ agentsEnabled: false, readable: false });
  });

  it("treats a thrown query as unreadable rather than propagating", async () => {
    // Nothing here may throw into the middle of an agent step.
    q.mockRejectedValue(new Error("connection refused"));
    expect(await readContainmentState("ws")).toEqual({ agentsEnabled: false, readable: false });
  });

  it("scopes the read to the workspace", async () => {
    q.mockResolvedValue({ rows: [{ agents_enabled: true }] });
    await readContainmentState("ws-42");
    expect(q).toHaveBeenCalledWith(expect.stringContaining("workspace_id = $1"), ["ws-42"]);
  });
});

describe("readRunSpend", () => {
  it("returns the recorded spend", async () => {
    q.mockResolvedValue({ rows: [{ tokens: 10, duration_ms: 20, egress_calls: 3, spend_cents: 4 }] });
    expect(await readRunSpend("ws", "r1")).toEqual({ tokens: 10, durationMs: 20, egressCalls: 3, spendCents: 4 });
  });

  it("returns NaN, not zero, when the ledger cannot be read", async () => {
    // Zeroing it would hand a run an unlimited budget at exactly the moment the
    // database is unhealthy. decideStep reads a non-finite figure as unreadable.
    q.mockRejectedValue(new Error("down"));
    const spend = await readRunSpend("ws", "r1");
    expect(Number.isNaN(spend.tokens)).toBe(true);
    expect(decideStep(DEFAULT_BUDGET, spend, { agentsEnabled: true, readable: true })).toMatchObject({
      proceed: false,
      breached: "unreadable",
    });
  });

  it("treats a missing ledger row the same way", async () => {
    q.mockResolvedValue({ rows: [] });
    expect(Number.isNaN((await readRunSpend("ws", "r1")).tokens)).toBe(true);
  });
});

describe("setAgentsEnabled", () => {
  it("records who stopped it and why, so it can be safely restarted", async () => {
    // "Someone turned it off at some point" does not tell the next person
    // whether turning it back on is safe.
    q.mockResolvedValue({ rows: [] });
    await setAgentsEnabled("ws", false, { userId: "u1", role: "cto", reason: "suspicious egress" });
    expect(q).toHaveBeenCalledWith(expect.stringContaining("instinct_agent_containment"), ["ws", false, "suspicious egress", "u1"]);
    expect(trackEvent).toHaveBeenCalledWith("containment.agents_stopped", "u1", "cto", expect.objectContaining({ workspace_id: "ws" }));
  });

  it("still records a stop with no reason given, rather than storing nothing", async () => {
    q.mockResolvedValue({ rows: [] });
    await setAgentsEnabled("ws", false, { userId: "u1", role: "cto" });
    expect(q.mock.calls[0][1][2]).toBe("no reason given");
  });

  it("clears the reason on resume", async () => {
    q.mockResolvedValue({ rows: [] });
    await setAgentsEnabled("ws", true, { userId: "u1", role: "cto" });
    expect(q.mock.calls[0][1][2]).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith("containment.agents_resumed", "u1", "cto", expect.any(Object));
  });
});

describe("addRunSpend", () => {
  it("adds rather than overwrites, so concurrent steps cannot lose each other's usage", async () => {
    q.mockResolvedValue({ rows: [] });
    await addRunSpend("ws", "r1", { tokens: 100 });
    expect(q.mock.calls[0][0]).toMatch(/tokens\s*=\s*tokens\s*\+/);
  });

  it("never records a negative delta", async () => {
    // A negative would give a run budget back, which is the one direction a
    // ledger must not move.
    q.mockResolvedValue({ rows: [] });
    await addRunSpend("ws", "r1", { tokens: -500, spendCents: -10 });
    expect(q.mock.calls[0][1].slice(2)).toEqual([0, 0, 0, 0]);
  });
});

describe("the test seam", () => {
  it("is inert until explicitly set, so production cannot accidentally use it", async () => {
    q.mockResolvedValue({ rows: [{ agents_enabled: true }] });
    // Nothing set: the real read runs.
    await readContainmentState("ws");
    expect(q).toHaveBeenCalled();
  });

  it("bypasses the database when set, and stops when cleared", async () => {
    _setContainmentStateForTests({ agentsEnabled: true, readable: true });
    expect(await readContainmentState("ws")).toEqual({ agentsEnabled: true, readable: true });
    expect(q).not.toHaveBeenCalled();

    _setContainmentStateForTests(null);
    q.mockResolvedValue({ rows: [] });
    await readContainmentState("ws");
    expect(q).toHaveBeenCalled();
  });
});
