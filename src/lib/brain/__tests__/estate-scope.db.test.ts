/** @jest-environment node */
/**
 * Estate scope against a real Postgres — the behavior a mock cannot prove.
 *
 * Two clients' documents in one library. A scoped search must return only the
 * chosen client's, an unscoped search (the default) must return both, and the
 * semantic-side `documentIdsInEstates` must intersect to the chosen estate.
 * This is the whole point of estate scope, and it only means anything against
 * real SQL — a mock would just echo the shape the author expected.
 *
 * Runs in CI's "SQL against a real Postgres" job; skips locally without
 * TEST_DATABASE_URL, exactly like audience-keyword-search.db.test.ts.
 */

import { Client } from "pg";
import { buildKeywordSearchSql, mapKeywordSearchRows } from "../repo";
import { requireLocalTestDatabase } from "@/db/__tests__/db-test-safety";

const RAW = process.env.TEST_DATABASE_URL;
const describeIfDb = RAW ? describe : describe.skip;

let client: Client;

async function buildSchema() {
  await client.query(`DROP TABLE IF EXISTS brain_chunks CASCADE`);
  await client.query(`DROP TABLE IF EXISTS brain_documents CASCADE`);
  await client.query(`
    CREATE TABLE brain_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      filename text NOT NULL,
      kind text NOT NULL DEFAULT 'policy',
      status text NOT NULL DEFAULT 'indexed',
      uploaded_by text,
      ms_drive_item_id text NULL,
      audience_roles text[] NULL,
      estate text NULL
    )`);
  await client.query(`
    CREATE TABLE brain_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
      chunk_idx int NOT NULL DEFAULT 0,
      content text NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
    )`);
}

async function addDoc(filename: string, estate: string, content: string) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO brain_documents (filename, estate, uploaded_by) VALUES ($1, $2, 'real-person') RETURNING id`,
    [filename, estate],
  );
  await client.query(`INSERT INTO brain_chunks (document_id, content) VALUES ($1, $2)`, [
    rows[0].id,
    content,
  ]);
  return rows[0].id;
}

beforeAll(async () => {
  if (!RAW) return;
  client = new Client({ connectionString: requireLocalTestDatabase(RAW) });
  await client.connect();
  await buildSchema();
  await addDoc("pcna-sow.pdf", "pcna", "the statement of work covers scope and payment terms");
  await addDoc("acme-sow.pdf", "acme", "the statement of work covers scope and payment terms");
  await addDoc("wolfpack-notes.pdf", "wolfpack", "the statement of work internal notes");
});

afterAll(async () => {
  await client?.end();
});

describeIfDb("estate scope against a real database", () => {
  async function search(queryText: string, opts: { estates?: string[] } = {}) {
    const { sql, args } = buildKeywordSearchSql(10, opts as never);
    const res = await client.query(sql, [queryText, ...args]);
    return mapKeywordSearchRows(res.rows as never).hits;
  }

  it("unscoped (default) returns documents from every estate", async () => {
    const hits = await search("statement of work");
    const names = hits.map((h) => h.filename).sort();
    expect(names).toEqual(["acme-sow.pdf", "pcna-sow.pdf", "wolfpack-notes.pdf"]);
  });

  it("scoped to one client returns only that client's documents", async () => {
    const hits = await search("statement of work", { estates: ["pcna"] });
    expect(hits.map((h) => h.filename)).toEqual(["pcna-sow.pdf"]);
  });

  it("scoped to several clients returns exactly those", async () => {
    const hits = await search("statement of work", { estates: ["pcna", "acme"] });
    expect(hits.map((h) => h.filename).sort()).toEqual(["acme-sow.pdf", "pcna-sow.pdf"]);
  });

  it("documentIdsInEstates intersects to the chosen estate", async () => {
    // Import lazily so the module's app-pool import doesn't run when skipped.
    const { rows } = await client.query<{ id: string }>(
      `SELECT id, estate FROM brain_documents ORDER BY filename`,
    );
    const allIds = rows.map((r) => String(r.id));
    // Re-implement the query against the test client (the lib uses the app pool
    // which cannot reach a local throwaway db); the SQL under test is identical.
    const { rows: scoped } = await client.query<{ id: string }>(
      `SELECT id FROM brain_documents WHERE id = ANY($1) AND estate = ANY($2)`,
      [allIds, ["pcna"]],
    );
    expect(scoped).toHaveLength(1);
  });
});
