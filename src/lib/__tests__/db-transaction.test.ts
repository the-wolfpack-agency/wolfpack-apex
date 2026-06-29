/**
 * withTransaction — the atomic-write seam added for the platform-scan data-loss
 * fix. Proves: BEGIN before fn, COMMIT on success, ROLLBACK + re-throw on failure,
 * the client is always released, tx.write enforces the expectRows row-count
 * contract (a 0-row write throws), and shadow mode (no DATABASE_URL) throws
 * no_database rather than silently no-op'ing a write.
 *
 * pg is mocked so no real connection is made: pool.connect() yields a mock client
 * whose query() is a jest.fn we can script + assert call order on.
 */

// A scriptable mock client. query() returns whatever the test queued; BEGIN /
// COMMIT / ROLLBACK resolve trivially so we can assert they were issued.
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(async () => ({
  query: (...a: unknown[]) => mockClientQuery(...a),
  release: (...a: unknown[]) => mockRelease(...a),
}));

jest.mock("pg", () => {
  class Pool {
    connect = () => mockConnect();
    query = jest.fn();
    on = jest.fn();
  }
  return { Pool };
});

import { withTransaction, WriteQueryError } from "@/lib/db";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test/db";
  // Default: BEGIN/COMMIT/ROLLBACK + any write resolve with one row.
  mockClientQuery.mockResolvedValue({ rows: [{ id: "r1" }] });
});

afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

test("COMMITs on success: BEGIN, the write, then COMMIT in order; client released", async () => {
  const out = await withTransaction(async (tx) => {
    const r = await tx.write<{ id: string }>("INSERT INTO t VALUES (1) RETURNING id", [], {
      expectRows: 1,
    });
    return r.rows[0].id;
  });
  expect(out).toBe("r1");
  const issued = mockClientQuery.mock.calls.map((c) => c[0]);
  expect(issued[0]).toBe("BEGIN");
  expect(issued).toContain("INSERT INTO t VALUES (1) RETURNING id");
  expect(issued[issued.length - 1]).toBe("COMMIT");
  expect(issued).not.toContain("ROLLBACK");
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("ROLLBACKs and re-throws when fn throws; client still released", async () => {
  await expect(
    withTransaction(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const issued = mockClientQuery.mock.calls.map((c) => c[0]);
  expect(issued[0]).toBe("BEGIN");
  expect(issued).toContain("ROLLBACK");
  expect(issued).not.toContain("COMMIT");
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("tx.write enforces expectRows: a 0-row write throws unexpected_row_count -> ROLLBACK", async () => {
  mockClientQuery.mockImplementation(async (text: string) => {
    if (text === "BEGIN" || text === "ROLLBACK" || text === "COMMIT") return { rows: [] };
    return { rows: [] }; // the write returns 0 rows (discarded by RLS/view)
  });
  await expect(
    withTransaction(async (tx) => {
      await tx.write("INSERT INTO t DEFAULT VALUES RETURNING id", [], { expectRows: 1 });
    }),
  ).rejects.toMatchObject({ name: "WriteQueryError", code: "unexpected_row_count" });
  expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
});

test("tx.write wraps a pg error as WriteQueryError(db_error) -> ROLLBACK + re-throw", async () => {
  mockClientQuery.mockImplementation(async (text: string) => {
    if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
    throw new Error("connection reset");
  });
  await expect(
    withTransaction(async (tx) => {
      await tx.write("INSERT INTO t DEFAULT VALUES", []);
    }),
  ).rejects.toMatchObject({ name: "WriteQueryError", code: "db_error" });
  expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("shadow mode (no DATABASE_URL) throws no_database, never connects", async () => {
  delete process.env.DATABASE_URL;
  await expect(withTransaction(async () => undefined)).rejects.toMatchObject({
    name: "WriteQueryError",
    code: "no_database",
  });
  expect(mockConnect).not.toHaveBeenCalled();
  expect(WriteQueryError).toBeDefined();
});
