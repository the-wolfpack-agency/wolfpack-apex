/**
 * The audience predicate and the withheld count, against a real Postgres.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM audience-evidence.test.ts. That test
 * mocks the repo, so it proves queryBrain REPORTS a withheld count. It cannot
 * prove the count is correct, because the count comes out of SQL and a mock
 * returns whatever it was told to. The interesting part here is a CTE with a
 * LEFT JOIN LATERAL, chosen because a plain `WHERE readable` returns no rows
 * at all for a role that may read none of the matches, which loses the count
 * in exactly the case most worth reporting. Nothing but a real database can
 * tell me whether that is true.
 *
 * A mock that returns the shape the author expects is the failure this whole
 * week has been about.
 *
 * SAFETY. This file builds schema, so it calls requireLocalTestDatabase()
 * first and refuses any non-local host. On 2026-08-26 a schema-building test
 * was pointed at production and dropped instinct_ms_tokens. The control is in
 * the code because the failure was a human reusing a command whose meaning had
 * changed underneath it, and that will happen again.
 *
 *   docker run -d -e POSTGRES_PASSWORD=t -e POSTGRES_DB=apextest -p 55999:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55999/apextest npx jest audience-keyword-search
 */

import { Client } from "pg";
import { requireLocalTestDatabase } from "@/db/__tests__/db-test-safety";
import { buildKeywordSearchSql, mapKeywordSearchRows } from "../repo";

const RAW = process.env.TEST_DATABASE_URL;
const describeIfDb = RAW ? describe : describe.skip;

let client: Client;

/* The two tables the search touches, and only those. */
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
      audience_roles text[] NULL
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

async function addDoc(filename: string, roles: string[] | null, content: string) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO brain_documents (filename, audience_roles) VALUES ($1, $2) RETURNING id`,
    [filename, roles],
  );
  await client.query(`INSERT INTO brain_chunks (document_id, content) VALUES ($1, $2)`, [
    rows[0].id,
    content,
  ]);
  return rows[0].id;
}

describeIfDb("keywordSearchWithAudience against a real database", () => {
  /**
   * Runs the REAL builder's SQL and the REAL row mapper, over this test's own
   * client. The app pool cannot be used: normalizeDatabaseUrlSsl rewrites every
   * connection string to sslmode=verify-full, so it can never reach a local
   * throwaway Postgres, and a schema-building test must never be pointed at a
   * hosted one. Everything with logic in it is the production code; only the
   * transport differs.
   */
  async function search(
    queryText: string,
    limit: number,
    opts: { role?: string; kind?: string } = {},
  ) {
    const { sql, args } = buildKeywordSearchSql(limit, opts as never);
    const res = await client.query(sql, [queryText, ...args]);
    return mapKeywordSearchRows(res.rows as never);
  }

  beforeAll(async () => {
    const url = requireLocalTestDatabase(RAW);
    client = new Client({ connectionString: url });
    await client.connect();
    await buildSchema();

    void url;

    /* One document the whole company may read, two that only HR may. */
    await addDoc("handbook.pdf", null, "the holiday policy allows twenty days");
    await addDoc("salaries.pdf", ["hr"], "the holiday policy for salary bands");
    await addDoc("grievance.pdf", ["hr"], "holiday policy grievance procedure");
  });

  afterAll(async () => {
    await client?.end();
  });

  it("withholds the restricted documents from a role that may not read them", async () => {
    const r = await search("holiday policy", 10, { role: "sales" });
    expect(r.hits.map((h) => h.filename)).toEqual(["handbook.pdf"]);
    /* THE NUMBER. Two matched and were withheld, and it says two. */
    expect(r.withheld).toBe(2);
  });

  it("returns the count when the role may read NOTHING that matched", async () => {
    /* The case a plain WHERE loses: zero rows come back, so a count derived
       from the returned rows would report zero withheld at the exact moment
       everything was withheld. */
    const r = await search("grievance procedure", 10, { role: "sales" });
    expect(r.hits).toEqual([]);
    expect(r.withheld).toBe(1);
  });

  it("withholds nothing from a role that reads everything", async () => {
    const r = await search("holiday policy", 10, { role: "cto" });
    expect(r.hits).toHaveLength(3);
    expect(r.withheld).toBe(0);
  });

  it("withholds nothing when no role is supplied", async () => {
    const r = await search("holiday policy", 10);
    expect(r.hits).toHaveLength(3);
    expect(r.withheld).toBe(0);
  });

  it("never emits a phantom hit when the lateral join finds nothing", async () => {
    /* The lateral yields one all-null row in that case, and treating it as a
       result would put a document with no filename in front of somebody. */
    const r = await search("nothing matches this phrase", 10, { role: "sales" });
    expect(r.hits).toEqual([]);
    expect(r.withheld).toBe(0);
  });

  it("counts withheld across the whole match set, not just the returned page", async () => {
    /* LIMIT applies to the readable rows. A withheld count that respected the
       limit would under-report exactly when the library is large. */
    const r = await search("holiday policy", 1, { role: "sales" });
    expect(r.hits).toHaveLength(1);
    expect(r.withheld).toBe(2);
  });

  it("still honours the status filter, so a half-ingested document is not quoted", async () => {
    await client.query(`UPDATE brain_documents SET status = 'queued' WHERE filename = 'handbook.pdf'`);
    const r = await search("holiday policy", 10, { role: "sales" });
    expect(r.hits).toEqual([]);
    await client.query(`UPDATE brain_documents SET status = 'indexed' WHERE filename = 'handbook.pdf'`);
  });
});

describe("the safety guard on this file", () => {
  it("refuses a hosted database", () => {
    expect(() =>
      requireLocalTestDatabase("postgres://u:p@ep-cool-name.us-east-1.aws.neon.tech/db"),
    ).toThrow();
  });
  it("refuses a url it cannot parse", () => {
    expect(() => requireLocalTestDatabase("not a url")).toThrow();
  });
});
