/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Every `ON CONFLICT (...)` in the codebase, checked against the LIVE schema.
 *
 * WHY THIS EXISTS, AND WHY IT READS THE DATABASE RATHER THAN THE MIGRATIONS.
 *
 * Postgres requires a UNIQUE index matching an upsert's conflict target. When
 * one is missing the statement raises 42P10, "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification" — every time, for every
 * row, forever. It is not a race or a load problem. It either works or it has
 * never worked.
 *
 * On 2026-09-02 the Microsoft token store had been failing that way for at
 * least a week. `storeTokens` upserts on connected_by; migration 006 created
 * that index UNIQUE and migration 044 renamed it, which preserves uniqueness.
 * The live index was not unique. Nothing in the chain explains the difference,
 * and no migration ran at the hour the tokens froze.
 *
 * That is the whole argument for checking production. A test built from the
 * migrations would have passed on the day the outage started, because the
 * migrations were right and the database was not. Schema drift is invisible to
 * anything that only reads the repository.
 *
 * WHY IT WENT A WEEK UNNOTICED is worth stating too, because the check is
 * shaped around it. storeTokens swallowed the error and the caller emitted
 * microsoft.token_refreshed on the next line, so the dashboards showed a
 * healthy connection refreshing 2,592 times a day. Interactive requests kept
 * working on the in-memory token each call produced; only code reading a
 * STORED token failed, and that is all background work. The SharePoint sync
 * stopped and the library repair failed every run, and neither said why.
 *
 * WHAT IT DOES NOT DO. It reads SQL as text, so it finds the upserts written
 * as literals and misses any built by string concatenation at runtime. That is
 * a floor, not a guarantee, and the count it prints is the honest size of what
 * it checked rather than a claim about the whole codebase.
 *
 *   npx tsx scripts/check-upsert-targets.ts
 *   npx tsx scripts/check-upsert-targets.ts --json
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/**
 * Its own connection, rather than @/lib/db.
 *
 * This check runs in three places against three different servers: a Postgres
 * container in CI with no SSL at all, the Neon database at deploy time, and
 * Neon again on a schedule. The app's pool is configured for production and
 * forces SSL, so in CI it failed with "The server does not support SSL
 * connections" and the check reported nothing.
 *
 * It only reads pg_catalog, so it has no need of the app's pool, its retries
 * or its caching. SSL is decided by the host: a local server does not have it,
 * anything else does.
 */
async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const local = /@(localhost|127\.0\.0\.1)\b/.test(url);
  const client = new Client({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ROOTS = ["src/lib", "src/app", "scripts"];
const CODE = /\.(ts|tsx|mjs)$/;

export interface UpsertSite {
  file: string;
  table: string;
  columns: string[];
  /** The predicate after the conflict target, when the upsert names one. */
  where: string | null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Pull `INSERT INTO <table> ... ON CONFLICT (<cols>)` pairs out of a file.
 *
 * The table is taken from the nearest preceding INSERT, because an upsert's
 * conflict target means nothing without knowing which table it is against, and
 * one file often holds several.
 *
 * `ON CONFLICT ON CONSTRAINT <name>` and bare `ON CONFLICT DO NOTHING` are
 * skipped: the first names a constraint directly, which Postgres resolves
 * itself, and the second has no target to check.
 */
/**
 * Normalize an index expression so the two sides can be compared.
 *
 * Postgres renders `LOWER(email)` as `lower((email)::text)`. The code writes
 * `LOWER(email)`. Casts, brackets and case are noise for this comparison and
 * everything else is signal, so both are reduced to letters and digits:
 * `loweremail`. Deliberately strict about nothing else, because a loose
 * comparison here would pass an index that does not actually cover the write.
 */
export function normalizeExpression(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/::[a-z_ ]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Upserts whose target is an expression; recorded so the gap is visible. */
export const expressionTargets: UpsertSite[] = [];

export function upsertSitesIn(source: string, file = "<inline>"): UpsertSite[] {
  const sites: UpsertSite[] = [];
  /* The optional trailing WHERE matters. A PARTIAL unique index is a legal
     conflict target only when the statement repeats its predicate, so reading
     the columns alone reports correct code as broken. That is not a detail:
     two of the first four findings from this check were partial-index upserts
     written exactly right, and a guard that is wrong three times out of four
     is one nobody reads twice. */
  /* ONE LEVEL OF NESTING IN THE TARGET. `[^)]*` stops at the first bracket, so
     `ON CONFLICT (LOWER(email))` did not match the pattern at all and the site
     vanished from the check rather than being reported as unchecked. A site
     that quietly leaves the count is worse than one that fails it: the total
     still looks healthy. Caught by counting the sites before and after adding
     exactly such a target. */
  const re =
    /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)([\s\S]*?)ON\s+CONFLICT\s*\(((?:[^()]|\([^()]*\))*)\)\s*(WHERE\s+([a-z0-9_. ]+?))?\s*DO\s/gi;
  for (const m of source.matchAll(re)) {
    /* A second INSERT between this one and the ON CONFLICT means the match
       spanned two statements and the table is the wrong one. */
    if (/INSERT\s+INTO\s+/i.test(m[2])) continue;
    const columns = m[3]
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase())
      .filter(Boolean);
    /* An expression target such as (lower(email)) is a valid upsert against a
       functional index. Matching those textually against pg_get_expr output is
       fragile, so they are recorded as expressions and REPORTED as unchecked
       rather than dropped: a site that quietly leaves the check is a site
       nobody knows is uncovered. */
    if (columns.some((c) => c.includes(" ") && !c.includes("("))) continue;
    if (columns.length) {
      sites.push({ file, table: m[1].toLowerCase(), columns, where: (m[5] ?? "").trim().toLowerCase() || null });
    }
  }
  return sites;
}

export interface LiveIndex {
  columns: string[];
  predicate: string | null;
  /** The index's own expression, for a functional index such as LOWER(email). */
  expression: string | null;
}

/** The SQL that lists unique indexes. Shared so every caller asks the same question. */
export const UNIQUE_INDEX_SQL = `
  SELECT t.relname AS table_name,
         /* LEFT JOIN, and filtered to real columns. An EXPRESSION index carries
            attnum 0 for its expression, which has no pg_attribute row, so an
            inner join dropped every functional index from the result. The
            check then reported three correct upserts as broken, including the
            two on instinct_team_members. Same class as the partial-index
            mistake earlier in this file: a query that quietly excludes a kind
            of index reports the code that uses it as wrong. */
         coalesce(array_agg(a.attname ORDER BY a.attname) FILTER (WHERE a.attname IS NOT NULL), '{}') AS columns,
         /* A partial unique index only covers a statement repeating this. */
         pg_get_expr(i.indpred, i.indrelid) AS predicate,
         /* The indexed expression itself, so a functional unique index can be
            compared with the expression the statement conflicts on. */
         pg_get_expr(i.indexprs, i.indrelid) AS expression
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_attribute a
           ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey) AND a.attnum > 0
   WHERE i.indisunique AND n.nspname = 'public'
   GROUP BY t.relname, i.indexrelid, i.indpred, i.indexprs, i.indrelid`;

/**
 * Shape the rows of UNIQUE_INDEX_SQL into the map the matcher reads.
 *
 * Exported because writing this twice is how the two callers end up disagreeing
 * about what a match is. It happened while writing this change: the db test got
 * its own copy and broke on the array handling immediately.
 */
export function indexRowsToMap(
  rows: Array<{
    table_name: string;
    columns: string[] | string;
    predicate: string | null;
    expression?: string | null;
  }>,
): Map<string, LiveIndex[]> {
  const byTable = new Map<string, LiveIndex[]>();
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? [];
    /* node-postgres hands a text[] back as an array, but a driver or a view can
       surface it as the raw literal. Normalized so the check does not depend on
       which. */
    const cols = Array.isArray(r.columns)
      ? r.columns
      : String(r.columns).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
    list.push({
      columns: cols.map((c) => String(c).toLowerCase()).sort(),
      predicate: r.predicate ? String(r.predicate).toLowerCase().replace(/[()]/g, "").trim() : null,
      expression: r.expression ? String(r.expression) : null,
    });
    byTable.set(r.table_name, list);
  }
  return byTable;
}

/** Unique indexes in the live database, as table -> index descriptions. */
export async function liveUniqueIndexes(client: Client): Promise<Map<string, LiveIndex[]>> {
  const { rows } = await client.query(UNIQUE_INDEX_SQL);
  return indexRowsToMap(rows as never);
}

/**
 * Which upserts have no unique index to conflict on.
 *
 * Split out from the run so the same rules can be applied to a schema built
 * from the migrations in CI, and to the live database on a schedule and at
 * deploy time. Three environments, one definition of "matched": if they used
 * different rules, the one that mattered would be the one nobody ran.
 */
export function matchUpserts(
  sites: UpsertSite[],
  unique: Map<string, LiveIndex[]>,
  tables: Set<string>,
): { broken: UpsertSite[]; skippedUnknownTable: number } {
  const broken: UpsertSite[] = [];
  let skippedUnknownTable = 0;
  for (const s of sites) {
    /* A table this database does not have is not a failure of this check: the
       code may target another tenant's schema, or a view. Counted, not judged. */
    if (!tables.has(s.table)) { skippedUnknownTable++; continue; }
    const want = [...s.columns].sort();
    const has = (unique.get(s.table) ?? []).some((ix) => {
      /* An expression target is matched against the index's own expression.
         These used to be reported as unchecked, which left the two upserts on
         instinct_team_members outside the guard entirely: exactly the table
         whose missing index this check was written for. */
      if (s.columns.some((c) => c.includes("("))) {
        if (!ix.predicate && ix.expression) {
          return normalizeExpression(ix.expression) === normalizeExpression(s.columns.join(","));
        }
        return false;
      }
      if (ix.columns.length !== want.length) return false;
      if (!ix.columns.every((c, i) => c === want[i])) return false;
      /* A full index covers any statement. A partial one covers only a
         statement that repeats its predicate. */
      if (!ix.predicate) return true;
      return s.where !== null && ix.predicate.includes(s.where);
    });
    if (!has) broken.push(s);
  }
  return { broken, skippedUnknownTable };
}

/** Ordinary tables in the connected database (views have no indexes). */
export async function liveTables(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
  );
  return new Set(rows.map((r) => r.relname));
}

/** Every upsert written as a literal anywhere in the source. */
export function allUpsertSites(): UpsertSite[] {
  const files = ROOTS.flatMap((r) => {
    try { return walk(r); } catch { return []; }
  });
  const sites: UpsertSite[] = [];
  for (const f of files) sites.push(...upsertSitesIn(readFileSync(f, "utf8"), f));
  return sites;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");

  /* NO DATABASE, NOTHING TO COMPARE AGAINST.
   *
   * This runs inside vercel-build, right after migrate, so a broken upsert
   * cannot be deployed. migrate itself no-ops without DATABASE_URL (shadow
   * mode), and a preview build with no database must keep building exactly as
   * it did before this check existed: turning those red would be a change to
   * deployment, not to correctness.
   *
   * The scheduled job does the opposite and REFUSES when the variable is
   * missing, because there its absence means the check verified nothing while
   * reporting green. Same script, and the difference is deliberate: here the
   * absence is expected, there it is the failure. */
  if (!process.env.DATABASE_URL) {
    console.log("[upsert] DATABASE_URL not set — nothing to check against (shadow mode).");
    process.exit(0);
  }
  const sites = allUpsertSites();
  const { unique, tables } = await withClient(async (c) => ({
    unique: await liveUniqueIndexes(c),
    tables: await liveTables(c),
  }));
  /* ORDINARY TABLES ONLY. A view has no indexes of its own, so including them
     reported every upsert through a view as broken. src/lib/people.ts writes to
     apex_employees, which is a view: a false positive, not a defect. */

  const { broken, skippedUnknownTable } = matchUpserts(sites, unique, tables);

  if (asJson) {
    console.log(JSON.stringify({ checked: sites.length, broken, skippedUnknownTable }, null, 2));
  } else {
    console.log(`[upsert] ${sites.length} upsert targets read from source`);
    if (expressionTargets.length) {
      console.log(
        `[upsert] ${expressionTargets.length} target(s) are expressions (e.g. LOWER(email)) and are not checked:`,
      );
      for (const e of expressionTargets) console.log(`           ${e.table} (${e.columns.join(", ")})  ${e.file}`);
    }
      console.log(
      `[upsert] ${skippedUnknownTable} against a view or a table this database does not have (not checked)`,
    );
    for (const b of broken) {
      console.error(
        `[upsert] NO UNIQUE INDEX  ${b.table} (${b.columns.join(", ")})  ${b.file}\n` +
          `           every write here raises 42P10 and always has.`,
      );
    }
    console.log(
      broken.length
        ? `\n[upsert] ${broken.length} upsert(s) cannot succeed against this database.`
        : `\n[upsert] every checked upsert has a unique index to conflict on.`,
    );
  }
  process.exit(broken.length ? 1 : 0);
}

/* Importable for tests without running the check. */
if (process.argv[1]?.includes("check-upsert-targets")) {
  main().catch((err) => {
    const e = err as Error & { code?: string };
    console.error("[upsert] failed:", e.message || "(no message)", e.code ?? "");
    process.exit(1);
  });
}
