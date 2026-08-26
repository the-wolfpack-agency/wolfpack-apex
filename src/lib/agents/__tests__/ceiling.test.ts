/**
 * What stops an agent running away.
 *
 * An agent had a role, an accountable owner and a lifecycle state, so a human
 * could pause or revoke one. Nothing stopped it on its own. A misbehaving
 * agent ran until somebody noticed, and "somebody notices" is not a control a
 * corporation can be asked to rely on: it is the thing they are buying us to
 * replace.
 */
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { checkAndRecordOperation, DEFAULT_MAX_OPERATIONS_PER_HOUR } from "../ceiling";

const ARGS = { workspaceId: "w1", agentId: "a1", operation: "create_document" };

/** ceiling row, then count row, then the insert. */
function respond(ceiling: number, used: number) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ max_operations_per_hour: ceiling }] })
    .mockResolvedValueOnce({ rows: [{ used: String(used) }] })
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => mockQuery.mockReset());

describe("the ceiling", () => {
  it("allows an agent under its limit", async () => {
    respond(60, 11);
    const v = await checkAndRecordOperation(ARGS);
    expect(v.allowed).toBe(true);
    expect(v.outcome).toBe("allowed");
  });

  it("refuses one that has reached it", async () => {
    respond(60, 60);
    const v = await checkAndRecordOperation(ARGS);
    expect(v.allowed).toBe(false);
    expect(v.outcome).toBe("refused_over_ceiling");
    expect(v.reason).toMatch(/60 of 60/);
  });

  /* A refusal that is not counted is a ceiling somebody walks through by
     retrying: the loop keeps calling, keeps being refused, keeps not counting. */
  it("records the attempt even when it refuses", async () => {
    respond(60, 60);
    await checkAndRecordOperation(ARGS);
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert![1]).toContain("refused_over_ceiling");
  });

  /* Zero means unlimited, and somebody had to choose it. */
  it("treats zero as unlimited", async () => {
    respond(0, 5000);
    const v = await checkAndRecordOperation(ARGS);
    expect(v.allowed).toBe(true);
    expect(v.reason).toMatch(/unlimited/);
  });

  it("defaults to a ceiling rather than to no ceiling", () => {
    expect(DEFAULT_MAX_OPERATIONS_PER_HOUR).toBeGreaterThan(0);
  });
});

describe("when the ceiling cannot be read", () => {
  /* An agent that keeps working when its limiter is broken is an agent with
     no limiter. */
  it("refuses rather than assuming it is fine", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const v = await checkAndRecordOperation(ARGS);
    expect(v.allowed).toBe(false);
    expect(v.outcome).toBe("refused_unreadable");
  });

  /* An agent from another workspace is not an agent this workspace may run,
     and the caller sees the same outcome either way: it does not run. */
  it("refuses an agent that is not in this workspace", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const v = await checkAndRecordOperation(ARGS);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no such agent/i);
  });

  it("scopes the lookup by workspace, not by agent id alone", async () => {
    respond(60, 1);
    await checkAndRecordOperation(ARGS);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/workspace_id = \$2/);
  });

  /* The count is the query the repo-wide guardrail flagged: a tally that reads
     across tenants is the shape of the bug even where this call cannot hit it. */
  it("scopes the hourly count by workspace too", async () => {
    respond(60, 1);
    await checkAndRecordOperation(ARGS);
    const countQ = mockQuery.mock.calls.find((c) => String(c[0]).includes("count(*)"));
    expect(String(countQ![0])).toMatch(/workspace_id = \$2/);
    expect(countQ![1]).toEqual(["a1", "w1"]);
  });
});
