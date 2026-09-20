/**
 * Operator-reputation schema against a REAL Postgres built from migration 260.
 * Proves the cross-workspace network read (exclude the caller, count OTHERS,
 * worst severity), the per-(operator,workspace) upsert, the opt-in upsert, and
 * migration idempotency. Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "260_operator_reputation.sql");

// Verbatim from operator-reputation.ts.
const REPORT = `INSERT INTO instinct_operator_reputation (operator_key, workspace_id, severity, behavior_classes)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (operator_key, workspace_id) DO UPDATE
       SET severity = EXCLUDED.severity, behavior_classes = EXCLUDED.behavior_classes, updated_at = now()`;
const NETWORK_READ = `SELECT operator_key,
            count(DISTINCT workspace_id) AS other_workspaces,
            max(CASE severity WHEN 'hostile' THEN 3 WHEN 'elevated' THEN 2 ELSE 1 END) AS sev_rank
       FROM instinct_operator_reputation
      WHERE operator_key = ANY($1) AND workspace_id <> $2
      GROUP BY operator_key`;

describeIfDb("operator reputation schema (migration 260)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_operator_reputation, instinct_reputation_optin`); });

  it("network read counts OTHER workspaces and excludes the caller", async () => {
    await db.query(REPORT, ["op_x", "w1", "hostile", []]);
    await db.query(REPORT, ["op_x", "w2", "elevated", []]);
    await db.query(REPORT, ["op_x", "w3", "hostile", []]);
    // caller = w1 -> should see 2 OTHER workspaces (w2, w3), worst severity hostile
    const r = await db.query(NETWORK_READ, [["op_x"], "w1"]);
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].other_workspaces)).toBe(2);
    expect(Number(r.rows[0].sev_rank)).toBe(3);
  });

  it("a workspace reporting an operator twice is one row (upsert), not two", async () => {
    await db.query(REPORT, ["op_y", "w1", "elevated", []]);
    await db.query(REPORT, ["op_y", "w1", "hostile", []]); // same (op, workspace)
    const r = await db.query(`SELECT count(*)::int AS n, max(severity) AS sev FROM instinct_operator_reputation WHERE operator_key = 'op_y'`);
    expect(r.rows[0].n).toBe(1);
    expect(r.rows[0].sev).toBe("hostile"); // updated in place
  });

  it("an operator only YOU reported returns nothing to you", async () => {
    await db.query(REPORT, ["op_solo", "w1", "hostile", []]);
    const r = await db.query(NETWORK_READ, [["op_solo"], "w1"]);
    expect(r.rows).toHaveLength(0);
  });

  it("opt-in upserts per workspace", async () => {
    const UP = `INSERT INTO instinct_reputation_optin (workspace_id, contribute, consume) VALUES ($1,$2,$3)
                ON CONFLICT (workspace_id) DO UPDATE SET contribute = EXCLUDED.contribute, consume = EXCLUDED.consume`;
    await db.query(UP, ["w1", true, false]);
    await db.query(UP, ["w1", true, true]);
    const r = await db.query(`SELECT contribute, consume FROM instinct_reputation_optin WHERE workspace_id = 'w1'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ contribute: true, consume: true });
  });

  it("rejects an out-of-vocabulary severity via CHECK", async () => {
    await expect(db.query(REPORT, ["op_z", "w1", "mild", []])).rejects.toThrow();
  });
});
