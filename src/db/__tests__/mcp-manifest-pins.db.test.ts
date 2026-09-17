/**
 * MCP manifest pins, run against a REAL Postgres built from the REAL migration
 * 252. Proves the pin store's SQL runs against the schema the migration produces:
 * the upsert round-trips a fingerprint, a re-pin updates in place, workspaces are
 * isolated, and the (workspace, target, server) unique constraint holds.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

// The store's SQL, verbatim (src/lib/ai-surface/mcp/pin-store.ts).
const UPSERT = `
  INSERT INTO instinct_mcp_manifest_pins (workspace_id, target, server, fingerprint, tool_count)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (workspace_id, target, server)
    DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
                  tool_count   = EXCLUDED.tool_count,
                  pinned_at    = now()
  RETURNING pinned_at::text AS pinned_at`;
const GET = `
  SELECT fingerprint, tool_count, pinned_at::text AS pinned_at
    FROM instinct_mcp_manifest_pins
   WHERE workspace_id = $1 AND target = $2 AND server = $3`;
const RAW_INSERT = `
  INSERT INTO instinct_mcp_manifest_pins (workspace_id, target, server, fingerprint, tool_count)
  VALUES ($1, $2, $3, $4, $5)`;

describeIfDb("MCP manifest pins", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_mcp_manifest_pins CASCADE`);
    await db.query(readFileSync(join(__dirname, "..", "migrations", "252_mcp_manifest_pins.sql"), "utf8"));
  });

  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_mcp_manifest_pins`); });

  it("pin then get round-trips the fingerprint", async () => {
    await db.query(UPSERT, ["w1", "ws-config", "srv", "abc123", 3]);
    const g = await db.query(GET, ["w1", "ws-config", "srv"]);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].fingerprint).toBe("abc123");
    expect(g.rows[0].tool_count).toBe(3);
  });

  it("re-pinning updates the fingerprint in place (no duplicate row)", async () => {
    await db.query(UPSERT, ["w1", "ws-config", "srv", "old", 2]);
    await db.query(UPSERT, ["w1", "ws-config", "srv", "new", 5]);
    const g = await db.query(GET, ["w1", "ws-config", "srv"]);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].fingerprint).toBe("new");
    expect(g.rows[0].tool_count).toBe(5);
    const count = await db.query(`SELECT count(*)::int AS n FROM instinct_mcp_manifest_pins`);
    expect(count.rows[0].n).toBe(1);
  });

  it("is workspace-isolated (a pin in ws A is invisible to ws B)", async () => {
    await db.query(UPSERT, ["wA", "ws-config", "srv", "fp", 1]);
    expect((await db.query(GET, ["wB", "ws-config", "srv"])).rows).toHaveLength(0);
  });

  it("the unique constraint rejects a duplicate (workspace, target, server)", async () => {
    await db.query(RAW_INSERT, ["w1", "ws-config", "srv", "fp1", 1]);
    await expect(
      db.query(RAW_INSERT, ["w1", "ws-config", "srv", "fp2", 2]),
    ).rejects.toThrow(/instinct_mcp_manifest_pins_uniq|duplicate key|unique constraint/i);
  });
});
