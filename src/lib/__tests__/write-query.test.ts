/**
 * writeQuery — the strict-write helper that eliminates the silent-
 * discard class of data bugs. Every branch is tested here so a future
 * change can't accidentally re-introduce the "200 with no data written"
 * failure mode.
 */

// Mock the underlying pool before importing the SUT.
const mockPoolQuery = jest.fn();
jest.mock("pg", () => ({
  Pool: jest.fn(() => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    on: jest.fn(),
    end: jest.fn(),
  })),
}));

// writeQuery uses DATABASE_URL to decide whether to throw no_database.
const ORIGINAL_DB_URL = process.env.DATABASE_URL;

describe("writeQuery", () => {
  let writeQuery: typeof import("@/lib/db").writeQuery;
  let WriteQueryError: typeof import("@/lib/db").WriteQueryError;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.DATABASE_URL = "postgres://test";
    // Re-import per test so singleton pool picks up env changes.
    const db = jest.requireActual("@/lib/db") as typeof import("@/lib/db");
    writeQuery = db.writeQuery;
    WriteQueryError = db.WriteQueryError;
  });

  afterAll(() => {
    if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB_URL;
  });

  it("returns rows on a successful write", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: "x" }] });
    const result = await writeQuery("INSERT INTO t (a) VALUES ($1) RETURNING *", ["v"]);
    expect(result.rows).toEqual([{ id: "x" }]);
  });

  it("THROWS WriteQueryError(no_database) when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    jest.resetModules();
    const db = jest.requireActual("@/lib/db") as typeof import("@/lib/db");
    try {
      await db.writeQuery("INSERT INTO t DEFAULT VALUES");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("WriteQueryError");
      expect((err as InstanceType<typeof WriteQueryError>).code).toBe("no_database");
    }
  });

  it("THROWS WriteQueryError(db_error) when the underlying pg call errors", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));
    try {
      await writeQuery("INSERT INTO t (id) VALUES ($1)", ["dup"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("WriteQueryError");
      expect((err as InstanceType<typeof WriteQueryError>).code).toBe("db_error");
      expect((err as Error).message).toContain("duplicate key");
    }
  });

  it("THROWS WriteQueryError(unexpected_row_count) when expectRows mismatches (silent-discard defense)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    try {
      await writeQuery("INSERT INTO t DEFAULT VALUES RETURNING *", [], { expectRows: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      const wqe = err as InstanceType<typeof WriteQueryError>;
      expect(wqe.name).toBe("WriteQueryError");
      expect(wqe.code).toBe("unexpected_row_count");
      expect(wqe.expected).toBe(1);
      expect(wqe.actual).toBe(0);
    }
  });

  it("does NOT throw when expectRows is omitted even if zero rows return", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await writeQuery("DELETE FROM t WHERE id = $1", ["nope"]);
    expect(result.rows).toEqual([]);
  });

  it("does not throw when the returned row count matches expectRows exactly", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const result = await writeQuery("INSERT INTO t SELECT * FROM src RETURNING *", [], { expectRows: 3 });
    expect(result.rows).toHaveLength(3);
  });

  it("THROWS when more rows return than expected (signals a schema bug)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }] });
    await expect(
      writeQuery("UPDATE t SET x = 1 WHERE pk = $1 RETURNING *", ["should-be-unique"], { expectRows: 1 }),
    ).rejects.toThrow("row-count mismatch");
  });
});
