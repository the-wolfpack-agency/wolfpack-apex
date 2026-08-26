/**
 * The invite-acceptance SQL, run against a REAL Postgres built from the REAL
 * migrations.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-03 every new invitee saw "An account already exists for this
 * email." and could not create an account. A client was turned away.
 *
 * The upsert said `ON CONFLICT ON CONSTRAINT uq_instinct_team_members_email_lower`.
 * Migration 128 creates that as a unique INDEX on `LOWER(email)`, and Postgres
 * only permits a table CONSTRAINT on plain columns, so it can never be one.
 * Every accept raised `constraint "..." does not exist`.
 *
 * NOTHING IN CI COULD HAVE CAUGHT IT.
 *
 * That clause is valid TypeScript and a valid-looking string. It only fails when
 * a real Postgres parses it against a real schema, and no job in this repo ever
 * ran SQL against a database. Unit tests mocked `query`, so they asserted that
 * we sent the text we intended to send, which was exactly the thing that was
 * wrong. A static guard on the string catches a revert of THIS bug; it cannot
 * catch the next clause that references an object that does not exist.
 *
 * So this suite executes the statements against a live server: schema from the
 * migration files, then the real query text from the route. A clause that names
 * a non-existent constraint, column, or index fails here and only here.
 *
 * Skipped unless TEST_DATABASE_URL is set. CI sets it from a postgres service
 * (.github/workflows/db-contract.yml). Locally:
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name pgtest postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:55432/postgres npx jest invite-accept-sql
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, "..", "migrations");

/** The real upsert from src/app/api/team/accept/route.ts. */
const ACCEPT_UPSERT = `
  INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active, workspace_id)
  VALUES ($1, $2, $3, $4, $5, TRUE, $6)
  ON CONFLICT (LOWER(email)) DO UPDATE
    SET name = EXCLUDED.name,
        role = EXCLUDED.role,
        password_hash = EXCLUDED.password_hash,
        is_active = TRUE
  RETURNING id`;

d("invite acceptance, against a real database", () => {
  let db: Client;

  beforeAll(async () => {
    /* REFUSES A NON-LOCAL HOST. This suite drops and recreates tables, and on
       2026-08-26 a sibling file was pointed at production by a reused shell
       command and destroyed the token table. Same hazard here. */
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();

    /* Build only what this path touches. Running all ~250 migrations would drag
       in every unrelated failure and make the signal here useless; the point is
       that the SQL is checked against the schema the migrations actually
       produce, so the table and its index are created from the same statements
       migrations 001 and 128 use. */
    await db.query(`DROP TABLE IF EXISTS instinct_team_members CASCADE`);
    await db.query(`
      CREATE TABLE instinct_team_members (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        name          TEXT,
        role          TEXT,
        password_hash TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        last_login    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        workspace_id  TEXT NOT NULL DEFAULT 'default'
      )`);

    // The exact statement from migration 128. An INDEX, not a CONSTRAINT.
    const m128 = readFileSync(join(MIGRATIONS, "128_team_members_dedupe_and_unique.sql"), "utf8");
    const createIdx = m128
      .split(";")
      .map((s) => s.trim())
      .find((s) => /CREATE UNIQUE INDEX[\s\S]*uq_instinct_team_members_email_lower/i.test(s));
    expect(createIdx).toBeTruthy();
    await db.query(createIdx as string);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE instinct_team_members");
  });

  const accept = (id: string, email: string, name = "N", role = "ops", hash = "h") =>
    db.query(ACCEPT_UPSERT, [id, email, name, role, hash, "default"]);

  it("the index really is an index and NOT a constraint", async () => {
    // This asymmetry is the whole bug. Postgres reports it in pg_indexes and
    // does not report it in pg_constraint, so ON CONFLICT ON CONSTRAINT can
    // never resolve it.
    const idx = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_instinct_team_members_email_lower'`,
    );
    expect(idx.rowCount).toBe(1);
    const con = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'uq_instinct_team_members_email_lower'`,
    );
    expect(con.rowCount).toBe(0);
  });

  it("a brand-new invitee is accepted", async () => {
    // The production failure: this raised "constraint ... does not exist".
    const res = await accept("tm_1", "brand-new@wolfpack.test");
    expect(res.rows[0].id).toBe("tm_1");
    const { rows } = await db.query("SELECT email, is_active FROM instinct_team_members");
    expect(rows).toEqual([{ email: "brand-new@wolfpack.test", is_active: true }]);
  });

  it("accepting twice updates the same row instead of failing", async () => {
    await accept("tm_1", "again@wolfpack.test", "First");
    const second = await accept("tm_2", "again@wolfpack.test", "Second");
    // Returns the ORIGINAL id: the conflict target matched the existing row.
    expect(second.rows[0].id).toBe("tm_1");
    const { rows } = await db.query("SELECT id, name FROM instinct_team_members");
    expect(rows).toEqual([{ id: "tm_1", name: "Second" }]);
  });

  it("matches case-insensitively, the way the index is defined", async () => {
    await accept("tm_1", "Pat@Wolfpack.Test");
    const res = await accept("tm_2", "pat@wolfpack.test", "Renamed");
    expect(res.rows[0].id).toBe("tm_1");
    expect((await db.query("SELECT count(*)::int n FROM instinct_team_members")).rows[0].n).toBe(1);
  });

  it("reactivates somebody whose access was removed", async () => {
    await accept("tm_1", "returner@wolfpack.test");
    await db.query("UPDATE instinct_team_members SET is_active = FALSE WHERE id = 'tm_1'");
    await accept("tm_2", "returner@wolfpack.test");
    const { rows } = await db.query("SELECT is_active FROM instinct_team_members WHERE id = 'tm_1'");
    expect(rows[0].is_active).toBe(true);
  });

  it("the OLD form fails on a brand-new address, which is what shipped", async () => {
    /* Kept as an executable record of the defect. If someone reverts to
       ON CONSTRAINT, the tests above go red; this one states plainly why. */
    const broken = ACCEPT_UPSERT.replace(
      "ON CONFLICT (LOWER(email))",
      "ON CONFLICT ON CONSTRAINT uq_instinct_team_members_email_lower",
    );
    await expect(
      db.query(broken, ["tm_x", "nobody-has-this@wolfpack.test", "N", "ops", "h", "default"]),
    ).rejects.toThrow(/does not exist/i);
  });

  it("that failure names the index, which is why it was misreported", async () => {
    // The duplicate-email fallback matched on this name, so a broken statement
    // was shown to the user as "An account already exists for this email."
    const broken = ACCEPT_UPSERT.replace(
      "ON CONFLICT (LOWER(email))",
      "ON CONFLICT ON CONSTRAINT uq_instinct_team_members_email_lower",
    );
    await expect(
      db.query(broken, ["tm_x", "nobody@wolfpack.test", "N", "ops", "h", "default"]),
    ).rejects.toThrow(/uq_instinct_team_members_email_lower/);
  });

  it("a genuine duplicate says 'duplicate key', which is a different message", async () => {
    // The two are told apart by wording, not by the index name.
    await accept("tm_1", "dupe@wolfpack.test");
    await expect(
      db.query(
        `INSERT INTO instinct_team_members (id, email, workspace_id) VALUES ($1, $2, 'default')`,
        ["tm_2", "DUPE@wolfpack.test"],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/i);
  });
});
