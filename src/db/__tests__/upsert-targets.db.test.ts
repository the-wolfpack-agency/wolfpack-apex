/** @jest-environment node */
/**
 * Every `ON CONFLICT` in the source, against a schema built from the migrations.
 *
 * THIS IS THE LAYER THAT NEEDS NO SECRET AND RUNS BEFORE MERGE. db-contract
 * spins up a real Postgres, applies every migration, and runs this. So a new
 * upsert whose unique index nobody added is caught in the pull request that
 * introduces it, on any machine, with no production access.
 *
 * WHAT IT CANNOT CATCH, said plainly so nobody mistakes it for the whole
 * guarantee. On 2026-09-02 the Microsoft token store had been raising 42P10 in
 * production for a week, and the migrations were RIGHT: 006 created the index
 * UNIQUE and 044 renamed it, which preserves uniqueness. The live index was
 * not unique and nothing in the chain explains why. This test would have
 * passed on every day of that outage.
 *
 * Drift between the repository and the database is invisible to anything that
 * only reads the repository. That is why there are two other layers: the same
 * check runs against the real database at deploy time (npm run vercel-build,
 * after migrate) and again daily. This one stops the mistake being written;
 * those two stop it being served.
 *
 * WHY THE SHARED MATCHER MATTERS. All three import matchUpserts from the same
 * module. Three copies of "does this index match" would drift, and the copy
 * that mattered would be the one nobody ran.
 */

import { Pool } from "pg";
import {
  allUpsertSites,
  matchUpserts,
  indexRowsToMap,
  UNIQUE_INDEX_SQL,
  type LiveIndex,
} from "../../../scripts/check-upsert-targets";

/* TEST_DATABASE_URL is the convention every other *.db.test.ts uses, and
   db-contract sets exactly that. Reading DATABASE_URL instead would have made
   this file skip in CI while looking present, which is the failure this whole
   change is about. DATABASE_URL is accepted as a fallback for a local run. */
const CONNECTION = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeOrSkip = CONNECTION ? describe : describe.skip;

describeOrSkip("every upsert has a unique index to conflict on", () => {
  let pool: Pool;
  let unique: Map<string, LiveIndex[]>;
  let tables: Set<string>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    /* The same SQL and the same shaping the script uses. This file briefly had
       its own copy of both and the copy was wrong within minutes, which is the
       argument for sharing them rather than a hypothetical one. */
    const idx = await pool.query(UNIQUE_INDEX_SQL);
    unique = indexRowsToMap(idx.rows as never);

    const tbl = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
    );
    tables = new Set(tbl.rows.map((r) => r.relname));
  }, 60_000);

  afterAll(async () => { await pool?.end(); });

  it("finds upserts to check at all", () => {
    /* A parser that silently stopped matching would make this whole file
       report success while checking nothing, which is the failure mode the
       check itself exists to catch. */
    expect(allUpsertSites().length).toBeGreaterThan(50);
  });

  it("leaves none of them unmatched", () => {
    const { broken } = matchUpserts(allUpsertSites(), unique, tables);
    const described = broken.map((b) => `${b.table} (${b.columns.join(", ")}) in ${b.file}`);
    /* Listed rather than counted: "3 broken" sends somebody hunting, and every
       one of these raises 42P10 on every write, forever. */
    expect(described).toEqual([]);
  });

  /* THE ONE THAT BROKE. Pinned by name as well as by the sweep above, because
     a regression here stops the SharePoint sync and the library repair and
     says nothing while it does. */
  it("keeps the Microsoft token upsert able to conflict", async () => {
    /* DIAGNOSTIC, kept deliberately. When this fails the question is always
       "what does the index actually look like", and answering it from the
       migrations has been wrong twice. Printing the live definitions turns a
       boolean into something a person can act on. */
    if (!(unique.get("instinct_ms_tokens") ?? []).length) {
      const all = await pool.query(
        `SELECT c.relkind, i.indexdef FROM pg_indexes i
           JOIN pg_class c ON c.relname = i.tablename
          WHERE i.tablename IN ('instinct_ms_tokens','apex_ms_tokens')`,
      );
      console.error("indexes present:", JSON.stringify(all.rows, null, 2));
    }
    const forTokens = (unique.get("instinct_ms_tokens") ?? []).some(
      (ix) => ix.columns.length === 1 && ix.columns[0] === "connected_by" && !ix.predicate,
    );
    expect(forTokens).toBe(true);
  });
});
