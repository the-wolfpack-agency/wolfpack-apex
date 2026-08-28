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
const mockQdrantConfigured = jest.fn(() => true);
jest.mock("@/lib/qdrant", () => ({
  upsertKnowledgePoint: (...a: unknown[]) => mockQdrant(...a),
  getQdrantHealth: jest.fn(async () => true),
  isQdrantConfigured: () => mockQdrantConfigured(),
}));

const mockNeo = jest.fn();
const mockNeoConfigured = jest.fn(() => true);
jest.mock("@/lib/neo4j", () => ({
  recordKnowledgeInteraction: (...a: unknown[]) => mockNeo(...a),
  getNeo4jHealth: jest.fn(async () => false),
  isNeo4jConfigured: () => mockNeoConfigured(),
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


/**
 * THE CASE THAT COULD NOT FIRE.
 *
 * Both store writers return Promise<void>. They swallow their own errors, and
 * when the store is not configured they return early. So every settled result
 * was { status: "fulfilled", value: undefined }, and the old inspect() matched
 * neither "rejected" nor "value === false".
 *
 * That is why a deployment where Neo4j has never been configured has recorded
 * zero degrade events. The signal was not quiet because nothing was wrong. It
 * was quiet because it could not speak.
 */
describe("a store that is not configured at all", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = "postgres://test";
    mockQdrantConfigured.mockReturnValue(true);
    mockNeoConfigured.mockReturnValue(true);
    mockQuery.mockResolvedValue({ rows: [] });
    const mod = await import("@/lib/triple-write");
    mod.__resetDegradedReportingForTests();
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL;
  });

  it("reports the graph store as degraded when it was never configured", async () => {
    mockNeoConfigured.mockReturnValue(false);
    /* Resolving undefined is exactly what the real writer does when it has no
       URL: it returns early, having written nothing. */
    mockNeo.mockResolvedValue(undefined);
    mockQdrant.mockResolvedValue(undefined);

    const { tripleWriteKnowledge } = await import("@/lib/triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);

    const rows = degradeRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0][1]![3]))).toMatchObject({
      store: "neo4j",
      reason: "not configured",
    });
  });

  it("says nothing when both stores are configured and the writes land", async () => {
    mockNeo.mockResolvedValue(undefined);
    mockQdrant.mockResolvedValue(undefined);

    const { tripleWriteKnowledge } = await import("@/lib/triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);

    expect(degradeRows()).toHaveLength(0);
  });

  /* An unconfigured store fails on every write, so one event per write would
     be tens of thousands of identical rows a day. That is a worse kind of
     silence than none. */
  it("reports the transition once, not once per write", async () => {
    mockNeoConfigured.mockReturnValue(false);
    mockNeo.mockResolvedValue(undefined);
    mockQdrant.mockResolvedValue(undefined);

    const { tripleWriteKnowledge } = await import("@/lib/triple-write");
    for (let i = 0; i < 5; i++) {
      await tripleWriteKnowledge(`k${i}`, "q", "a", "src", "u1", []);
    }

    expect(degradeRows()).toHaveLength(1);
  });

  it("reports each store separately", async () => {
    mockNeoConfigured.mockReturnValue(false);
    mockQdrantConfigured.mockReturnValue(false);
    mockNeo.mockResolvedValue(undefined);
    mockQdrant.mockResolvedValue(undefined);

    const { tripleWriteKnowledge } = await import("@/lib/triple-write");
    await tripleWriteKnowledge("k1", "q", "a", "src", "u1", []);

    const stores = degradeRows().map((c) => JSON.parse(String(c[1]![3])).store).sort();
    expect(stores).toEqual(["neo4j", "qdrant"]);
  });
});
