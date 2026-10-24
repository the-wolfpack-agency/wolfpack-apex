/**
 * The RLS cutover flag in db.ts (INSTINCT_RLS_SESSION_CONTEXT). Proves:
 *   - flag OFF (default): query() is the plain pool path even when a workspace
 *     is bound, and bindRequestWorkspace binds nothing;
 *   - flag ON + bound workspace: BEGIN -> set_config(app.workspace_id) ->
 *     statement -> COMMIT on one client, which is always released;
 *   - a failed set_config refuses the statement (ROLLBACK, re-throw) instead of
 *     running it without tenant context;
 *   - a binding made inside an awaited helper (as requireCapability does) is
 *     visible to the caller afterwards, and concurrent requests never see each
 *     other's workspace;
 *   - withSystemScope sets app.rls_system and refuses to nest in a workspace.
 *
 * pg is mocked (same harness as db-workspace-scope.test.ts).
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
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import "./helpers/next-request-als";
import { pool, query, withSystemScope, withWorkspaceScope } from "@/lib/db";
import {
  bindRequestWorkspace,
  boundRequestWorkspace,
  rlsSessionContextEnabled,
  runWithRequestWorkspace,
} from "@/lib/db/request-workspace";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";

const poolQuery = pool.query as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test/db";
  delete process.env.INSTINCT_RLS_SESSION_CONTEXT;
  mockClientQuery.mockResolvedValue({ rows: [{ via: "client" }] });
  poolQuery.mockResolvedValue({ rows: [{ via: "pool" }] });
});

function statements(): string[] {
  return mockClientQuery.mock.calls.map((c) => String(c[0]));
}

describe("flag parsing", () => {
  it.each([[undefined, false], ["", false], ["off", false], ["on", true], ["TRUE", true], ["1", true]])("%p -> %p", (v, want) => {
    expect(rlsSessionContextEnabled(v === undefined ? ({} as unknown as NodeJS.ProcessEnv) : ({ INSTINCT_RLS_SESSION_CONTEXT: v } as unknown as NodeJS.ProcessEnv))).toBe(want);
  });
});

describe("flag OFF (production today)", () => {
  it("query() uses the pool even inside a bound workspace", async () => {
    const res = await runWithRequestWorkspace("ws-A", () => query("SELECT 1"));
    expect(res.rows[0].via).toBe("pool");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("bindRequestWorkspace binds nothing, even inside a request", async () => {
    await workUnitAsyncStorage.run({ type: "request" } as never, async () => {
      bindRequestWorkspace("ws-A");
      expect(boundRequestWorkspace()).toBeUndefined();
    });
  });
});

describe("flag ON", () => {
  beforeEach(() => {
    process.env.INSTINCT_RLS_SESSION_CONTEXT = "on";
  });

  it("sets app.workspace_id in a one-statement transaction and releases the client", async () => {
    const res = await runWithRequestWorkspace("ws-A", () => query("SELECT * FROM t WHERE id = $1", ["x"]));
    expect(res.rows[0].via).toBe("client");
    expect(statements()).toEqual([
      "BEGIN",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT * FROM t WHERE id = $1",
      "COMMIT",
    ]);
    expect(mockClientQuery.mock.calls[1][1]).toEqual(["ws-A"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("an unbound query (no authenticated request) still uses the pool", async () => {
    const res = await query("SELECT 1");
    expect(res.rows[0].via).toBe("pool");
  });

  it("refuses the statement when set_config fails", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("set_config")) throw new Error("permission denied");
      return { rows: [] };
    });
    await expect(runWithRequestWorkspace("ws-A", () => query("SELECT secret FROM t"))).rejects.toThrow("permission denied");
    expect(statements()).not.toContain("SELECT secret FROM t");
    expect(statements()).toContain("ROLLBACK");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rolls back and re-throws when the statement fails", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE")) throw new Error("boom");
      return { rows: [] };
    });
    await expect(runWithRequestWorkspace("ws-A", () => query("UPDATE t SET x = 1"))).rejects.toThrow("boom");
    expect(statements()).toContain("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("an explicit withWorkspaceScope still wins over the request binding", async () => {
    await runWithRequestWorkspace("ws-A", () => withWorkspaceScope("ws-A", () => query("SELECT 2")));
    // One scope transaction, not a nested per-statement one.
    expect(statements().filter((s) => s === "BEGIN")).toHaveLength(1);
  });

  it("a binding made inside an awaited helper reaches the caller, per request, never across requests", async () => {
    async function authenticate(ws: string): Promise<void> {
      await new Promise((r) => setTimeout(r, 1));
      bindRequestWorkspace(ws);
    }
    async function handler(ws: string): Promise<string | undefined> {
      await authenticate(ws);
      await new Promise((r) => setTimeout(r, 2));
      return boundRequestWorkspace();
    }
    // Next.js runs every route handler inside its own work-unit store; simulate
    // three concurrent requests the same way.
    const asRequest = (ws: string) => workUnitAsyncStorage.run({ type: "request" } as never, () => handler(ws));
    const seen = await Promise.all([asRequest("ws-A"), asRequest("ws-B"), asRequest("ws-C")]);
    expect(seen).toEqual(["ws-A", "ws-B", "ws-C"]);
  });

  it("outside any request nothing is bound", async () => {
    bindRequestWorkspace("ws-A");
    expect(boundRequestWorkspace()).toBeUndefined();
  });
});

describe("withSystemScope", () => {
  it("sets app.rls_system for the scope and commits", async () => {
    const res = await withSystemScope(() => query("SELECT 3"));
    expect(res.rows[0].via).toBe("client");
    expect(statements()).toEqual(["BEGIN", "SELECT set_config('app.rls_system', 'on', true)", "SELECT 3", "COMMIT"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("refuses to nest inside a workspace scope (and vice versa)", async () => {
    await expect(withWorkspaceScope("ws-A", () => withSystemScope(async () => 1))).rejects.toThrow(/nesting mismatch/);
    await expect(withSystemScope(() => withWorkspaceScope("ws-A", async () => 1))).rejects.toThrow(/nesting mismatch/);
  });

  it("shadow mode runs fn without connecting", async () => {
    delete process.env.DATABASE_URL;
    await expect(withSystemScope(async () => "ok")).resolves.toBe("ok");
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
