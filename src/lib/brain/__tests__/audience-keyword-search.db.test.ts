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
      ms_drive_item_id text NULL,
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

async function addDoc(
  filename: string,
  roles: string[] | null,
  content: string,
  uploadedBy: string | null = "real-person",
) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO brain_documents (filename, audience_roles, uploaded_by) VALUES ($1, $2, $3) RETURNING id`,
    [filename, roles, uploadedBy],
  );
  await client.query(`INSERT INTO brain_chunks (document_id, content) VALUES ($1, $2)`, [
    rows[0].id,
    content,
  ]);
  return rows[0].id;
}

/* ONE connection and ONE schema for every block in this file. These lived in
   the first describe's beforeAll/afterAll, which closed the client before the
   second block ran: the corpus tests then failed on a dead connection rather
   than on anything they were asserting. */
beforeAll(async () => {
  if (!RAW) return;
  const url = requireLocalTestDatabase(RAW);
  client = new Client({ connectionString: url });
  await client.connect();
  await buildSchema();

  /* One document the whole company may read, two that only HR may. */
  await addDoc("handbook.pdf", null, "the holiday policy allows twenty days");
  await addDoc("salaries.pdf", ["hr"], "the holiday policy for salary bands");
  await addDoc("grievance.pdf", ["hr"], "holiday policy grievance procedure");
});

afterAll(async () => {
  await client?.end();
});

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

/**
 * The corpus boundary, in SQL, against a real database.
 *
 * corpus.test.ts proves the helper agrees with itself. This proves the
 * PREDICATE actually removes rows, which is the only version that matters:
 * 744 of the Brain's 795 answerable documents are demo fixtures and scanner
 * output, and a predicate that composed wrongly would leave every one of them
 * reachable while the unit tests stayed green.
 */
describeIfDb("the corpus boundary excludes synthetic documents", () => {
  beforeAll(async () => {
    await addDoc("demo-fixture.pdf", null, "holiday policy demo fixture", "demo-cto");
    /* A real client document that the 2026-05-16 sync happened to ingest under
       the demo-cto user id. Provenance, not the uploader, decides. */
    await client.query(
      `INSERT INTO brain_documents (filename, audience_roles, uploaded_by, ms_drive_item_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      ["2026_STRATEGY_Updated.pdf", null, "demo-cto", "drive-item-1"],
    );
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM brain_documents WHERE filename = '2026_STRATEGY_Updated.pdf'`,
    );
    await client.query(`INSERT INTO brain_chunks (document_id, content) VALUES ($1,$2)`, [
      rows[0].id,
      "the holiday policy for the 2026 strategy",
    ]);
    await addDoc("scan-finding.txt", null, "holiday policy scanner finding", "platform-scan");
    await addDoc("unknown-provenance.pdf", null, "holiday policy from nobody", null);
  });

  async function search(queryText: string, limit: number, opts: { role?: string } = {}) {
    const { sql, args } = buildKeywordSearchSql(limit, opts as never);
    const res = await client.query(sql, [queryText, ...args]);
    return mapKeywordSearchRows(res.rows as never);
  }

  it("DOES return a client document the sync ingested under the demo user id", async () => {
    /* 275 genuine documents were hidden this way: the May sync ran as
       demo-cto, so a strategy deck and the BA101 training days were treated as
       fixtures and never quoted. */
    const r = await search("holiday policy", 50, { role: "cto" });
    expect(r.hits.map((h) => h.filename)).toContain("2026_STRATEGY_Updated.pdf");
  });

  it("never returns the demo seeder's or the scanner's documents", async () => {
    const r = await search("holiday policy", 50, { role: "cto" });
    const names = r.hits.map((h) => h.filename);
    expect(names).not.toContain("demo-fixture.pdf");
    expect(names).not.toContain("scan-finding.txt");
  });

  it("still returns a real person's document", async () => {
    /* The other half. An exclusion that removed everything would pass the
       assertion above and be catastrophic. */
    const r = await search("holiday policy", 50, { role: "cto" });
    expect(r.hits.map((h) => h.filename)).toContain("handbook.pdf");
  });

  it("keeps a document whose uploader is unknown", async () => {
    const r = await search("holiday policy", 50, { role: "cto" });
    expect(r.hits.map((h) => h.filename)).toContain("unknown-provenance.pdf");
  });

  it("applies to a role that reads everything, because it is not an audience rule", async () => {
    const asCto = await search("holiday policy", 50, { role: "cto" });
    const asSales = await search("holiday policy", 50, { role: "sales" });
    for (const r of [asCto, asSales]) {
      expect(r.hits.map((h) => h.filename)).not.toContain("demo-fixture.pdf");
    }
  });

  it("does not count an excluded document as withheld by AUDIENCE", async () => {
    /* The withheld number means "your role may not read this". Folding the
       corpus boundary into it would report a governance filter that never
       happened, which is the exact class of wrong number this codebase spent
       the week removing. */
    const r = await search("holiday policy", 50, { role: "cto" });
    expect(r.withheld).toBe(0);
  });
});
