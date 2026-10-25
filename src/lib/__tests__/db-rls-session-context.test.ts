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
 *   - withSystemScope sets app.rls_system per statement under the flag, is
 *     invisible with the flag off, narrows to an inner workspace binding, and
 *     refuses to nest with a pinned withWorkspaceScope;
 *   - withTransaction sets the same context query() would (flag on), and with
 *     the flag off issues exactly BEGIN, the writes, COMMIT.
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
import { pool, query, withSystemScope, withTransaction, withWorkspaceScope } from "@/lib/db";
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
  it("flag OFF: a marker nothing reads; the statement goes to the pool unchanged", async () => {
    const res = await withSystemScope(() => query("SELECT 3"));
    expect(res.rows[0].via).toBe("pool");
    expect(mockConnect).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledWith("SELECT 3", undefined);
  });

  describe("flag ON", () => {
    beforeEach(() => {
      process.env.INSTINCT_RLS_SESSION_CONTEXT = "on";
    });

    it("sets app.rls_system in a one-statement transaction per query", async () => {
      const res = await withSystemScope(async () => {
        await query("SELECT 3");
        return query("SELECT 4");
      });
      expect(res.rows[0].via).toBe("client");
      expect(statements()).toEqual([
        "BEGIN", "SELECT set_config('app.rls_system', 'on', true)", "SELECT 3", "COMMIT",
        "BEGIN", "SELECT set_config('app.rls_system', 'on', true)", "SELECT 4", "COMMIT",
      ]);
      expect(mockRelease).toHaveBeenCalledTimes(2);
    });

    it("one failed statement does not poison the next (no long transaction)", async () => {
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql === "SELECT bad") throw new Error("boom");
        return { rows: [{ via: "client" }] };
      });
      const out = await withSystemScope(async () => {
        await query("SELECT bad").catch(() => undefined);
        return query("SELECT good");
      });
      expect(out.rows[0].via).toBe("client");
      expect(statements()).toContain("SELECT good");
    });

    it("wins over the request binding, and an inner workspace binding narrows it", async () => {
      await runWithRequestWorkspace("ws-A", () => withSystemScope(() => query("SELECT sys")));
      await withSystemScope(() => runWithRequestWorkspace("ws-B", () => query("SELECT ws")));
      const s = statements();
      expect(s.slice(0, 4)).toEqual(["BEGIN", "SELECT set_config('app.rls_system', 'on', true)", "SELECT sys", "COMMIT"]);
      expect(s.slice(4)).toEqual(["BEGIN", "SELECT set_config('app.workspace_id', $1, true)", "SELECT ws", "COMMIT"]);
      expect(mockClientQuery.mock.calls[5][1]).toEqual(["ws-B"]);
      expect(boundRequestWorkspace()).toBeUndefined();
    });

    it("refuses the statement when the system setting cannot be set", async () => {
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("rls_system")) throw new Error("denied");
        return { rows: [] };
      });
      await expect(withSystemScope(() => query("SELECT secret"))).rejects.toThrow("denied");
      expect(statements()).not.toContain("SELECT secret");
      expect(statements()).toContain("ROLLBACK");
    });
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

describe("runWithRequestWorkspace", () => {
  it("an empty workspace binds nothing", async () => {
    expect(runWithRequestWorkspace("", () => boundRequestWorkspace())).toBeUndefined();
  });

  it("refuses to re-scope a pinned withWorkspaceScope to another workspace", async () => {
    await expect(withWorkspaceScope("ws-A", async () => runWithRequestWorkspace("ws-B", () => 1))).rejects.toThrow(/nesting mismatch/);
    await expect(withWorkspaceScope("ws-A", async () => runWithRequestWorkspace("ws-A", () => 1))).resolves.toBe(1);
  });
});

describe("withTransaction RLS context", () => {
  const write = (sql: string) => withTransaction((tx) => tx.write(sql));

  it("flag OFF: exactly BEGIN, the write, COMMIT, even when bound or under system scope", async () => {
    await write("INSERT 1");
    await runWithRequestWorkspace("ws-A", () => write("INSERT 2"));
    await withSystemScope(() => write("INSERT 3"));
    expect(statements()).toEqual([
      "BEGIN", "INSERT 1", "COMMIT",
      "BEGIN", "INSERT 2", "COMMIT",
      "BEGIN", "INSERT 3", "COMMIT",
    ]);
  });

  describe("flag ON", () => {
    beforeEach(() => {
      process.env.INSTINCT_RLS_SESSION_CONTEXT = "on";
    });

    it("sets app.workspace_id for a bound workspace, before any write", async () => {
      await runWithRequestWorkspace("ws-A", () =>
        withTransaction(async (tx) => {
          await tx.write("INSERT a");
          await tx.write("INSERT b");
        }),
      );
      expect(statements()).toEqual(["BEGIN", "SELECT set_config('app.workspace_id', $1, true)", "INSERT a", "INSERT b", "COMMIT"]);
      expect(mockClientQuery.mock.calls[1][1]).toEqual(["ws-A"]);
    });

    it("sets app.rls_system under withSystemScope", async () => {
      await withSystemScope(() => write("INSERT s"));
      expect(statements()).toEqual(["BEGIN", "SELECT set_config('app.rls_system', 'on', true)", "INSERT s", "COMMIT"]);
    });

    it("with no context it runs as before (unbound, like query())", async () => {
      await write("INSERT n");
      expect(statements()).toEqual(["BEGIN", "INSERT n", "COMMIT"]);
    });

    it("refuses the writes when the setting fails, rolls back, releases", async () => {
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("set_config")) throw new Error("denied");
        return { rows: [] };
      });
      await expect(runWithRequestWorkspace("ws-A", () => write("INSERT x"))).rejects.toThrow("denied");
      expect(statements()).not.toContain("INSERT x");
      expect(statements()).toContain("ROLLBACK");
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  it("inside an explicit withWorkspaceScope the transaction inherits that workspace", async () => {
    await withWorkspaceScope("ws-P", () => write("INSERT p"));
    const s = statements();
    // scope: BEGIN, set_config; tx (own client): BEGIN, set_config, INSERT, COMMIT; scope COMMIT
    expect(s.filter((x) => x === "SELECT set_config('app.workspace_id', $1, true)")).toHaveLength(2);
    expect(s.indexOf("INSERT p")).toBeGreaterThan(s.lastIndexOf("SELECT set_config('app.workspace_id', $1, true)"));
    expect(mockClientQuery.mock.calls.filter((c) => String(c[0]).includes("set_config")).map((c) => c[1])).toEqual([["ws-P"], ["ws-P"]]);
  });
});
