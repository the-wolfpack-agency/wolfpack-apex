/**
 * Proof that the shared db mock models the real module.
 *
 * A mock is only useful if it stays in step with the thing it stands for. This
 * reads db.ts's actual export list and asserts makeDbMock() provides every one
 * — so adding an export to db.ts and forgetting the mock fails HERE, with a
 * message naming the missing export, rather than three months later as
 * "activePool is not a function" in an unrelated suite.
 *
 * That is not hypothetical. Adding activePool() cost 46 mock corrections, and
 * three of those tests opened real network sockets before anyone noticed the
 * override was doing nothing.
 *
 * The second half checks the DEFAULTS are safe. A mock whose writeQuery
 * silently resolves lets a test assert a write that never happened, which is a
 * worse failure than a missing export: it passes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDbMock, inertPool } from "./db-mock";

const DB_TS = join(__dirname, "..", "..", "db.ts");

/** Every runtime value db.ts exports. Types are irrelevant to a mock. */
export function runtimeExportsOfDbModule(): string[] {
  const source = readFileSync(DB_TS, "utf-8");
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)) names.add(m[1]);
  // `export { normalizeDatabaseUrlSsl };` — a re-export is still an export.
  for (const m of source.matchAll(/^export\s*\{\s*([^}]+)\s*\}\s*;/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith("type ")) names.add(name);
    }
  }
  return [...names].sort();
}

describe("the shared db mock models the real module", () => {
  const real = runtimeExportsOfDbModule();
  const mock = makeDbMock();

  it("finds the real exports, so a broken parse cannot pass by finding nothing", () => {
    // A reader that silently matches zero exports asserts nothing forever.
    expect(real.length).toBeGreaterThan(8);
    expect(real).toContain("query");
    expect(real).toContain("activePool");
  });

  it("provides every runtime export db.ts has", () => {
    const missing = real.filter((name) => !(name in mock));
    expect({
      hint: "db.ts gained an export. Add it to makeDbMock() so the 274 test mocks that use it keep modelling the real module.",
      missing,
    }).toEqual({ hint: expect.any(String), missing: [] });
  });

  it("provides nothing db.ts does not export", () => {
    // A mock offering an export the module lacks teaches a test to depend on
    // something that will not be there at runtime.
    const extra = Object.keys(mock).filter((name) => !real.includes(name));
    expect({ hint: "Not a real export of db.ts. Remove it from makeDbMock().", extra }).toEqual({
      hint: expect.any(String),
      extra: [],
    });
  });
});

describe("the defaults are safe rather than convenient", () => {
  it("reads return empty instead of throwing", async () => {
    const mock = makeDbMock();
    await expect((mock.query as jest.Mock)()).resolves.toMatchObject({ rows: [] });
    await expect((mock.safeQuery as jest.Mock)()).resolves.toMatchObject({ rows: [], fromCache: true });
  });

  it("writes REFUSE by default, so a test cannot assert a write that never happened", async () => {
    // The dangerous default. A silently-resolving writeQuery makes a test pass
    // while proving nothing, which is worse than a missing export because
    // nothing fails.
    const mock = makeDbMock();
    await expect((mock.writeQuery as jest.Mock)()).rejects.toThrow(/no database mock/);
    await expect((mock.withTransaction as jest.Mock)()).rejects.toThrow(/no database mock/);
  });

  it("gives activePool and pool the SAME object", () => {
    // The specific trap: overriding one and not the other. In the real module
    // activePool() closes over the internal pool, so a test that overrides
    // `pool` alone changes nothing and silently uses the real one.
    const mock = makeDbMock();
    expect((mock.activePool as jest.Mock)()).toBe(mock.pool);
  });

  it("runs the callback for both scopes, so a test never hangs", async () => {
    const mock = makeDbMock();
    await expect((mock.withWorkspaceScope as jest.Mock)("ws", async () => "ran")).resolves.toBe("ran");
    await expect((mock.withTenant as jest.Mock)("acme", async () => "ran")).resolves.toBe("ran");
  });

  it("lets a caller override just one thing and keep the rest", async () => {
    const mock = makeDbMock({ safeQuery: jest.fn(async () => ({ rows: [{ id: 1 }], fromCache: false })) });
    await expect((mock.safeQuery as jest.Mock)()).resolves.toMatchObject({ rows: [{ id: 1 }] });
    // Untouched exports still work.
    expect((mock.activePool as jest.Mock)()).toBeDefined();
  });

  it("hands out an inert pool that cannot reach a socket", async () => {
    const pool = inertPool();
    const client = await pool.connect();
    await expect(client.query()).resolves.toMatchObject({ rows: [] });
    expect(client.release).not.toHaveBeenCalled();
  });
});
