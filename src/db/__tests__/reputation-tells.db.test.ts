/**
 * Reputation TTP sharing against a REAL Postgres: migration 268 adds a `tells`
 * column (idempotent), and the network read aggregates behavior classes + tells
 * across workspaces into one deduped tradecraft set. This is what lets another
 * workspace recognize an actor's METHODS, not just its fingerprint. Skipped
 * unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const M = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");

// Mirrors the aggregation in getNetworkReputation: union behavior_classes || tells,
// distinct across all OTHER workspaces, excluding the caller.
const READ = `SELECT r.operator_key,
        count(DISTINCT r.workspace_id) AS other_workspaces,
        array_remove(array_agg(DISTINCT sig.tag), NULL) AS ttps
   FROM instinct_operator_reputation r
   LEFT JOIN LATERAL unnest(r.behavior_classes || r.tells) AS sig(tag) ON true
  WHERE r.operator_key = ANY($1) AND r.workspace_id <> $2
  GROUP BY r.operator_key`;

const UPSERT = `INSERT INTO instinct_operator_reputation (operator_key, workspace_id, severity, behavior_classes, tells)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (operator_key, workspace_id) DO UPDATE
       SET severity = EXCLUDED.severity, behavior_classes = EXCLUDED.behavior_classes, tells = EXCLUDED.tells, updated_at = now()`;

describeIfDb("reputation TTP sharing (migration 268)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const base = M("260_operator_reputation.sql");
    await db.query(base);
    const tells = M("268_reputation_tells.sql");
    await db.query(tells);
    await db.query(tells); // idempotent - ADD COLUMN IF NOT EXISTS
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_operator_reputation"); });

  it("defaults tells to an empty array", async () => {
    await db.query(UPSERT, ["op_x", "w1", "hostile", ["vuln_scanner"], []]);
    const r = await db.query("SELECT tells FROM instinct_operator_reputation WHERE operator_key='op_x'");
    expect(r.rows[0].tells).toEqual([]);
  });

  it("aggregates behavior classes + tells across workspaces, deduped, excluding the caller", async () => {
    // Two OTHER workspaces report op_x with overlapping + distinct tradecraft.
    await db.query(UPSERT, ["op_x", "w2", "hostile", ["aggressive_scraper"], ["tripped_decoy", "id_enumeration"]]);
    await db.query(UPSERT, ["op_x", "w3", "hostile", ["exploit_attempt"], ["tripped_decoy", "payload_attack"]]);
    // The caller's own report must NOT be included.
    await db.query(UPSERT, ["op_x", "w1", "hostile", ["only_mine"], ["only_mine_tell"]]);

    const r = await db.query(READ, [["op_x"], "w1"]);
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].other_workspaces)).toBe(2);
    const ttps = (r.rows[0].ttps as string[]).sort();
    expect(ttps).toEqual(
      ["aggressive_scraper", "exploit_attempt", "id_enumeration", "payload_attack", "tripped_decoy"].sort(),
    );
    expect(ttps).not.toContain("only_mine");
    expect(ttps).not.toContain("only_mine_tell");
  });

  it("counts an operator with empty arrays as a reporter (LEFT JOIN, no ttps)", async () => {
    await db.query(UPSERT, ["op_y", "w2", "elevated", [], []]);
    const r = await db.query(READ, [["op_y"], "w1"]);
    expect(Number(r.rows[0].other_workspaces)).toBe(1);
    expect(r.rows[0].ttps).toEqual([]);
  });
});
