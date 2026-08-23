/**
 * A store that is down is a state, not an event stream.
 *
 * The architecture doc has always said triple-write "degrades to
 * Postgres-only and logs system.triple_write_degraded". Measured on
 * production 2026-08-23: Neo4j has never been configured there, the
 * readiness endpoint reports it missing, and the number of degrade events
 * ever recorded is zero.
 *
 * Both call sites used Promise.allSettled, which never rejects, so the
 * outer catch was unreachable and every settled result was discarded
 * unread. The product has been running as a DOUBLE write while describing
 * itself as a triple write.
 */

export {};

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

const mockQdrant = jest.fn();
jest.mock("@/lib/qdrant", () => ({
  upsertKnowledgePoint: (...a: unknown[]) => mockQdrant(...a),
  getQdrantHealth: jest.fn(async () => true),
}));

const mockNeo = jest.fn();
jest.mock("@/lib/neo4j", () => ({
  recordKnowledgeInteraction: (...a: unknown[]) => mockNeo(...a),
  getNeo4jHealth: jest.fn(async () => false),
}));

const ORIGINAL = process.env.DATABASE_URL;

function degradeRows() {
  return mockQuery.mock.calls.filter((c) =>
    Array.isArray(c[1]) && c[1][0] === "system.triple_write_degraded",
  );
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  mockQuery.mockResolvedValue({ rows: [] });
  mockQdrant.mockResolvedValue(true);
  mockNeo.mockResolvedValue(true);
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe("when a secondary store does not take the write", () => {
  it("says which one, instead of nothing", async () => {
    mockNeo.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { tripleWriteKnowledge } = await import("../triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);

    const rows = degradeRows();
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0][1][3]);
    expect(meta.store).toBe("neo4j");
    expect(meta.reason).toContain("ECONNREFUSED");
  });

  it("counts a client that returns false rather than throwing", async () => {
    /* An unconfigured store client answers false instead of raising. That
       is still a store that did not receive the write, and it is the exact
       shape production has been in. */
    mockNeo.mockResolvedValue(false);
    const { tripleWriteKnowledge } = await import("../triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);
    expect(JSON.parse(degradeRows()[0][1][3]).store).toBe("neo4j");
  });

  it("reports the transition once and then stays quiet", async () => {
    /* An unconfigured store fails on EVERY write. One row per write would
       be tens of thousands of identical rows a day, which is a worse kind
       of silence than none. */
    mockNeo.mockResolvedValue(false);
    const { tripleWriteKnowledge } = await import("../triple-write");
    for (let i = 0; i < 25; i++) {
      await tripleWriteKnowledge(`k${i}`, "q", "a", "src", "u1", []);
    }
    expect(degradeRows()).toHaveLength(1);
  });

  it("reports each store separately", async () => {
    mockNeo.mockResolvedValue(false);
    mockQdrant.mockRejectedValue(new Error("qdrant unreachable"));
    const { tripleWriteKnowledge } = await import("../triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);
    expect(degradeRows().map((r) => JSON.parse(r[1][3]).store).sort()).toEqual([
      "neo4j",
      "qdrant",
    ]);
  });

  it("says nothing at all when both stores took the write", async () => {
    const { tripleWriteKnowledge } = await import("../triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);
    expect(degradeRows()).toHaveLength(0);
  });
});

describe("the diagnostic cannot break what it is diagnosing", () => {
  it("does not throw when the events insert itself fails", async () => {
    mockNeo.mockResolvedValue(false);
    mockQuery.mockRejectedValue(new Error("events table is gone"));
    const { tripleWriteKnowledge } = await import("../triple-write");
    await expect(
      tripleWriteKnowledge("k1", "q", "a", "src", "u1", []),
    ).resolves.toBeUndefined();
  });

  it("does not report through trackEvent, which would feed itself", async () => {
    /* analytics.ts calls tripleWriteEvent. Reporting a failure through
       trackEvent would be a loop, so the row goes straight to the table. */
    mockNeo.mockResolvedValue(false);
    const { tripleWriteEvent } = await import("../triple-write");
    await tripleWriteEvent({
      event_type: "knowledge.question_asked",
      user_id: "u1",
      user_role: "dev",
      metadata: {},
    });
    /* One insert, written here, rather than a second pass through the
       analytics layer that called us. */
    expect(degradeRows()).toHaveLength(1);
  });

  it("writes nothing when there is no database to write to", async () => {
    delete process.env.DATABASE_URL;
    mockNeo.mockResolvedValue(false);
    const { tripleWriteKnowledge } = await import("../triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);
    expect(degradeRows()).toHaveLength(0);
  });
});
