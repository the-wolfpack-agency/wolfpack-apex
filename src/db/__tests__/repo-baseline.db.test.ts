/**
 * Repo baseline schema, run against a REAL Postgres built from migration 273.
 * Proves the store's upsert + read SQL runs against the real schema (one row per
 * (workspace_id, repo), re-baseline upserts, workspace scope) and that the
 * migration is idempotent.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATION = join(__dirname, "..", "migrations", "273_repo_baseline.sql");

// Verbatim from src/lib/ai-code/baseline-store.ts.
const UPSERT = `INSERT INTO instinct_repo_baseline
       (workspace_id, repo, default_branch, checks, total_count, failing_count, failing_checks, captured_by, captured_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())
     ON CONFLICT (workspace_id, repo)
       DO UPDATE SET default_branch = EXCLUDED.default_branch,
                     checks = EXCLUDED.checks,
                     total_count = EXCLUDED.total_count,
                     failing_count = EXCLUDED.failing_count,
                     failing_checks = EXCLUDED.failing_checks,
                     captured_by = EXCLUDED.captured_by,
                     captured_at = now()`;
const READ = `SELECT repo, default_branch, total_count, failing_count, failing_checks, checks, captured_at::text AS captured_at
       FROM instinct_repo_baseline WHERE workspace_id = $1 AND repo = $2`;

describeIfDb("repo baseline schema (migration 273)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent: running twice must not throw
  });
  afterAll(async () => {
    await db.query("DROP TABLE IF EXISTS instinct_repo_baseline");
    await db.end();
  });

  it("stores a baseline and reads it back, workspace-scoped", async () => {
    await db.query(UPSERT, ["w1", "o/r", "main", JSON.stringify([{ name: "unit", status: "completed", conclusion: "success" }]), 3, 1, ["e2e"], "u1"]);
    const { rows } = await db.query(READ, ["w1", "o/r"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].failing_count).toBe(1);
    expect(rows[0].failing_checks).toEqual(["e2e"]);
    expect(rows[0].default_branch).toBe("main");
    // a different workspace never sees it
    const other = await db.query(READ, ["w2", "o/r"]);
    expect(other.rows).toHaveLength(0);
  });

  it("re-baselining upserts the SAME row (one baseline per repo), not a duplicate", async () => {
    await db.query(UPSERT, ["w1", "o/r", "main", JSON.stringify([]), 3, 1, ["e2e"], "u1"]);
    await db.query(UPSERT, ["w1", "o/r", "develop", JSON.stringify([]), 4, 0, [], "u2"]);
    const { rows } = await db.query(READ, ["w1", "o/r"]);
    expect(rows).toHaveLength(1); // upsert, not insert
    expect(rows[0].failing_count).toBe(0); // the latest snapshot won
    expect(rows[0].default_branch).toBe("develop");
  });
});
