/**
 * Structural invariants for migration 226_site_acceptance.
 *
 * Raw SQL text only, no live DB. The invariants asserted here are the ones that
 * would let the layer lie if they drifted: a run that can be recorded twice, a
 * status the app writes and nothing reads, a row that is not tenant scoped, or a
 * migration that cannot be re-run on a database that already has it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const upSql = readFileSync(join(MIGRATIONS_DIR, "226_site_acceptance.sql"), "utf8");
const downSql = readFileSync(join(MIGRATIONS_DIR, "226_site_acceptance.down.sql"), "utf8");

const CRITERIA = "instinct_site_acceptance";
const RUNS = "instinct_site_acceptance_runs";

describe("migration 226 — site acceptance", () => {
  it("creates both tables idempotently, so a re-run on a live database is a no-op", () => {
    expect(upSql).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${CRITERIA}\\b`));
    expect(upSql).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${RUNS}\\b`));
  });

  it("guards every index, including the drop side", () => {
    const creates = upSql.match(/CREATE\s+(UNIQUE\s+)?INDEX[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const stmt of creates) expect(stmt).toMatch(/IF\s+NOT\s+EXISTS/i);

    const drops = downSql.match(/DROP\s+(INDEX|TABLE)[^;]*/gi) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    for (const stmt of drops) expect(stmt).toMatch(/IF\s+EXISTS/i);
  });

  it("scopes both tables by workspace, as TEXT", () => {
    // TEXT because workspace ids are TEXT throughout this schema and the API
    // falls back to the literal 'default', which is not a UUID.
    const criteriaBlock = upSql.slice(upSql.indexOf(CRITERIA), upSql.indexOf(RUNS));
    expect(criteriaBlock).toMatch(/workspace_id\s+TEXT\s+NOT\s+NULL/);
    const runsBlock = upSql.slice(upSql.indexOf(`CREATE TABLE IF NOT EXISTS ${RUNS}`));
    expect(runsBlock).toMatch(/workspace_id\s+TEXT\s+NOT\s+NULL/);
  });

  it("makes one deploy judgeable exactly once", () => {
    // Without this a replayed webhook creates a second pending row and the drain
    // runs the same deploy twice, producing two verdicts for one build.
    expect(upSql).toMatch(new RegExp(`CREATE\\s+UNIQUE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+\\w+\\s+ON\\s+${RUNS}\\s*\\(\\s*deploy_id\\s*\\)`, "i"));
  });

  it("constrains the status vocabulary in the database, not only in the app", () => {
    expect(upSql).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i);
    for (const status of ["queued", "running", "passed", "failed", "degraded"]) {
      expect(upSql).toContain(`'${status}'`);
    }
  });

  it("adds the status constraint conditionally, so re-running does not error", () => {
    expect(upSql).toMatch(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/i);
  });

  it("defaults a new run to queued, so a recorded deploy is never implicitly passed", () => {
    expect(upSql).toMatch(/status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'queued'/i);
  });

  it("keeps the verdict and the criteria as JSONB owned by the app layer", () => {
    expect(upSql).toMatch(/criteria\s+JSONB\s+NOT\s+NULL/);
    expect(upSql).toMatch(/verdict\s+JSONB/);
  });

  it("indexes the drain and the per-project timeline the UI reads", () => {
    expect(upSql).toMatch(/idx_site_acceptance_runs_queued/);
    expect(upSql).toMatch(/idx_site_acceptance_runs_project/);
  });

  it("drops the child table before the parent contract in the down migration", () => {
    // Match to the end of the statement: the contract's table name is a prefix
    // of the runs table's, so a plain indexOf finds the wrong line for both.
    const runsAt = downSql.search(new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${RUNS}\\s*;`, "i"));
    const criteriaAt = downSql.search(new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${CRITERIA}\\s*;`, "i"));
    expect(runsAt).toBeGreaterThanOrEqual(0);
    expect(criteriaAt).toBeGreaterThanOrEqual(0);
    expect(runsAt).toBeLessThan(criteriaAt);
  });
});
