/**
 * ai-code reviews store, run against a REAL Postgres built from the REAL
 * migration 212. Proves the factory's recordReview / listReviews SQL runs
 * against the schema the migration produces, that the deterministic id dedups
 * (ON CONFLICT DO NOTHING), and that the read is workspace-isolated - the
 * predicate that IS the enforced tenant boundary for this table.
 *
 * This is the Code Factory's first DB-layer test: until now its persistence was
 * only ever exercised against a mocked query(), which proves we sent the SQL we
 * intended, never that it is correct or isolated against the real schema.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATION = join(__dirname, "..", "migrations", "212_ai_code_reviews.sql");

// Verbatim from src/lib/ai-code/store.ts.
const INSERT = `INSERT INTO instinct_ai_code_reviews
       (id, workspace_id, ref, author, outcome, highest_severity, finding_count, findings, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (id) DO NOTHING`;
const READ = `SELECT id, ref, author, outcome, highest_severity, finding_count, created_at::text AS created_at
       FROM instinct_ai_code_reviews
      WHERE workspace_id = $1
      ORDER BY created_at DESC`;

/** The store's deterministic id: acr_<sha256(workspace ref author nowIso)>. */
function reviewId(workspaceId: string, ref: string, author: string, nowIso: string): string {
  return `acr_${createHash("sha256").update([workspaceId, ref, author, nowIso].join(" ")).digest("hex").slice(0, 24)}`;
}

const NOW = "2026-10-03T12:00:00.000Z";
const row = (ws: string, ref: string, author = "gpt-4o-mini") => [
  reviewId(ws, ref, author, NOW), ws, ref, author, "allow", "none", 0, "[]", NOW,
];

describeIfDb("ai-code reviews store (migration 212)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_ai_code_reviews`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE instinct_ai_code_reviews`);
  });

  it("records a review and reads it back", async () => {
    await db.query(INSERT, row("w1", "pr-1"));
    const r = await db.query(READ, ["w1"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].ref).toBe("pr-1");
    expect(r.rows[0].outcome).toBe("allow");
  });

  it("dedups on the deterministic id (ON CONFLICT DO NOTHING)", async () => {
    await db.query(INSERT, row("w1", "pr-1"));
    await db.query(INSERT, row("w1", "pr-1")); // same workspace/ref/author/now -> same id
    expect((await db.query(READ, ["w1"])).rows).toHaveLength(1);
  });

  it("is workspace-isolated: w2 never sees w1's reviews", async () => {
    await db.query(INSERT, row("w1", "pr-1"));
    await db.query(INSERT, row("w1", "pr-2"));
    expect((await db.query(READ, ["w1"])).rows).toHaveLength(2);
    expect((await db.query(READ, ["w2"])).rows).toHaveLength(0);
  });

  it("two workspaces with the same ref get distinct rows (id includes the workspace)", async () => {
    await db.query(INSERT, row("w1", "pr-1"));
    await db.query(INSERT, row("w2", "pr-1"));
    expect((await db.query(READ, ["w1"])).rows).toHaveLength(1);
    expect((await db.query(READ, ["w2"])).rows).toHaveLength(1);
  });
});
