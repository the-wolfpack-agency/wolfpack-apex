/**
 * withWorkspaceScope — the session-var RLS retrofit foundation. Proves:
 * BEGIN -> set_config('app.workspace_id', ws, true) -> fn -> COMMIT in order;
 * inner query()/safeQuery() route to the SCOPED client (so RLS sees the GUC),
 * while OUTSIDE a scope query() uses the pool; ROLLBACK + re-throw on failure;
 * the client is always released; nesting reuses the same-workspace scope and
 * REFUSES a different-workspace re-scope; shadow mode (no DATABASE_URL) runs fn
 * without connecting; an empty workspaceId is rejected.
 *
 * pg is mocked so no real connection is made (same harness as db-transaction).
 */

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(async () => ({
  query: (...a: unknown[]) => mockClientQuery(...a),
  release: (...a: unknown[]) => mockRelease(...a),
}));

jest.mock("pg", () => {
  class Pool {
    connect = () => mockConnect();
    query = jest.fn(async () => ({ rows: [{ via: "pool" }] }));
    on = jest.fn();
  }
  return { Pool };
});

import { pool, query, safeQuery, withWorkspaceScope, activeWorkspaceScope } from "@/lib/db";

const poolQuery = pool.query as unknown as jest.Mock;
const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test/db";
  mockClientQuery.mockResolvedValue({ rows: [{ via: "client" }] });
  poolQuery.mockResolvedValue({ rows: [{ via: "pool" }] });
});

afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

test("BEGIN -> set_config(app.workspace_id, ws, true) -> COMMIT, client released", async () => {
  await withWorkspaceScope("ws-A", async () => {
    await query("SELECT 1");
  });
  const issued = mockClientQuery.mock.calls.map((c) => c[0]);
  expect(issued[0]).toBe("BEGIN");
  expect(issued).toContain("SELECT set_config('app.workspace_id', $1, true)");
  // the set_config call binds the workspace id
  const setCfg = mockClientQuery.mock.calls.find((c) => String(c[0]).includes("set_config"));
  expect(setCfg?.[1]).toEqual(["ws-A"]);
  expect(issued[issued.length - 1]).toBe("COMMIT");
  expect(issued).not.toContain("ROLLBACK");
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("inside the scope query() routes to the SCOPED client, not the pool", async () => {
  await withWorkspaceScope("ws-A", async () => {
    const r = await query<{ via: string }>("SELECT inside");
    expect(r.rows[0].via).toBe("client");
  });
  const clientStatements = mockClientQuery.mock.calls.map((c) => c[0]);
  expect(clientStatements).toContain("SELECT inside");
  // The pool was never used for the scoped statement.
  expect(poolQuery.mock.calls.map((c) => c[0])).not.toContain("SELECT inside");
});

test("safeQuery inside the scope also runs on the scoped client", async () => {
  await withWorkspaceScope("ws-A", async () => {
    const r = await safeQuery<{ via: string }>("SELECT safe");
    expect(r.rows[0].via).toBe("client");
  });
  expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain("SELECT safe");
});

test("OUTSIDE any scope, query() uses the pool (unchanged default)", async () => {
  expect(activeWorkspaceScope()).toBeUndefined();
  const r = await query<{ via: string }>("SELECT outside");
  expect(r.rows[0].via).toBe("pool");
  expect(poolQuery.mock.calls.map((c) => c[0])).toContain("SELECT outside");
  expect(mockConnect).not.toHaveBeenCalled();
});

test("activeWorkspaceScope reports the workspace while inside, undefined after", async () => {
  let inside: string | undefined;
  await withWorkspaceScope("ws-Z", async () => {
    inside = activeWorkspaceScope()?.workspaceId;
  });
  expect(inside).toBe("ws-Z");
  expect(activeWorkspaceScope()).toBeUndefined();
});

test("ROLLBACK + re-throw when fn throws; client still released; no COMMIT", async () => {
  await expect(
    withWorkspaceScope("ws-A", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const issued = mockClientQuery.mock.calls.map((c) => c[0]);
  expect(issued).toContain("ROLLBACK");
  expect(issued).not.toContain("COMMIT");
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("nesting the SAME workspace reuses the scope (no second connection)", async () => {
  await withWorkspaceScope("ws-A", async () => {
    await withWorkspaceScope("ws-A", async () => {
      await query("SELECT nested");
    });
  });
  expect(mockConnect).toHaveBeenCalledTimes(1); // only the outer scope connected
  expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain("SELECT nested");
});

test("nesting a DIFFERENT workspace is refused (cross-tenant nesting is a bug)", async () => {
  await expect(
    withWorkspaceScope("ws-A", async () => {
      await withWorkspaceScope("ws-B", async () => undefined);
    }),
  ).rejects.toThrow(/nesting mismatch/i);
});

test("an empty workspaceId is rejected before any connection", async () => {
  await expect(withWorkspaceScope("", async () => undefined)).rejects.toThrow(/non-empty workspaceId/i);
  expect(mockConnect).not.toHaveBeenCalled();
});

test("shadow mode (no DATABASE_URL) runs fn without connecting", async () => {
  delete process.env.DATABASE_URL;
  const out = await withWorkspaceScope("ws-A", async () => "ran");
  expect(out).toBe("ran");
  expect(mockConnect).not.toHaveBeenCalled();
});
