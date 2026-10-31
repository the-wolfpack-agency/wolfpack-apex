/** Page integrity (migration 305) against a real Postgres: idempotent, the scope
 *  and directive shapes are enforced, repeats count instead of adding rows, and
 *  the read folds distinct sessions and pages per origin. Skipped unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { getPageIntegrity, recordIntegrityReports } from "@/lib/forcefield/page-integrity";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "305_forcefield_page_integrity.sql");

describeIfDb("forcefield page integrity (migration 305)", () => {
  let db: Client;
  const q = (text: string, params: unknown[]) => db.query(text, params) as never;
  const R = (origin: string, page = "/") => [{ directive: "script-src", blockedOrigin: origin, page }];
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql); await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE forcefield_page_integrity"); });

  it("a repeat from the same session, origin and page counts, it does not add a row", async () => {
    await recordIntegrityReports("site:s", "aa", R("https://a.example"), q);
    await recordIntegrityReports("site:s", "aa", R("https://a.example"), q);
    const { rows } = await db.query("SELECT count(*)::int AS n, max(reports) AS reports FROM forcefield_page_integrity");
    expect(rows[0]).toEqual({ n: 1, reports: 2 });
  });

  it("the read counts distinct sessions and pages per origin, per scope only", async () => {
    for (const [sig, page] of [["s1", "/a"], ["s2", "/b"], ["s3", "/b"]]) await recordIntegrityReports("site:s", sig, R("https://skim.example", page), q);
    await recordIntegrityReports("site:other", "x", R("https://skim.example"), q);
    const r = await getPageIntegrity("site:s", { q });
    expect(r.origins).toHaveLength(1);
    expect(r.origins[0]).toMatchObject({ origin: "https://skim.example", sessions: 3, pages: 2, reports: 3, sessions24h: 3, pages24h: 2, status: "baseline" });
    expect(r.learning?.active).toBe(true);
  });

  it("the scope and directive shapes are enforced by the table, not only the API", async () => {
    await expect(db.query("INSERT INTO forcefield_page_integrity (scope, directive, blocked_origin, sig, page, day) VALUES ('anything', 'script-src', 'x', 's', '/', current_date)")).rejects.toThrow(/forcefield_page_integrity_scope_shape/);
    await expect(db.query("INSERT INTO forcefield_page_integrity (scope, directive, blocked_origin, sig, page, day) VALUES ('site:s', 'img-src', 'x', 's', '/', current_date)")).rejects.toThrow(/forcefield_page_integrity_directive/);
  });
});
