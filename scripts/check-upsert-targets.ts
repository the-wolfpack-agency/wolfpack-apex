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
import { query } from "@/lib/db";

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
export function upsertSitesIn(source: string, file = "<inline>"): UpsertSite[] {
  const sites: UpsertSite[] = [];
  /* The optional trailing WHERE matters. A PARTIAL unique index is a legal
     conflict target only when the statement repeats its predicate, so reading
     the columns alone reports correct code as broken. That is not a detail:
     two of the first four findings from this check were partial-index upserts
     written exactly right, and a guard that is wrong three times out of four
     is one nobody reads twice. */
  const re =
    /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)([\s\S]*?)ON\s+CONFLICT\s*\(([^)]*)\)\s*(WHERE\s+([a-z0-9_. ]+?))?\s*DO\s/gi;
  for (const m of source.matchAll(re)) {
    /* A second INSERT between this one and the ON CONFLICT means the match
       spanned two statements and the table is the wrong one. */
    if (/INSERT\s+INTO\s+/i.test(m[2])) continue;
    const columns = m[3]
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase())
      .filter(Boolean);
    /* An expression target such as (lower(email)) is a valid upsert against a
       functional index. Comparing those textually would report false failures,
       so they are counted as unchecked rather than guessed at. */
    if (columns.some((c) => c.includes("(") || c.includes(" "))) continue;
    if (columns.length) {
      sites.push({ file, table: m[1].toLowerCase(), columns, where: (m[5] ?? "").trim().toLowerCase() || null });
    }
  }
  return sites;
}

interface LiveIndex { columns: string[]; predicate: string | null }

/** Unique indexes in the live database, as table -> index descriptions. */
async function liveUniqueIndexes(): Promise<Map<string, LiveIndex[]>> {
  const { rows } = await query<{ table_name: string; columns: string[] | string; predicate: string | null }>(
    `SELECT t.relname AS table_name,
            array_agg(a.attname ORDER BY a.attname) AS columns,
            /* Kept rather than filtered out. A partial unique index IS a valid
               conflict target when the statement repeats this predicate, so
               the check needs to compare them rather than ignore them. */
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisunique
        AND n.nspname = 'public'
      GROUP BY t.relname, i.indexrelid, i.indpred, i.indrelid`,
  );
  const byTable = new Map<string, LiveIndex[]>();
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? [];
    /* node-postgres hands a text[] back as an array, but a driver or a view
       can surface it as the raw literal. Normalized so the check does not
       depend on which. */
    const cols = Array.isArray(r.columns)
      ? r.columns
      : String(r.columns).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
    list.push({
      columns: cols.map((c) => String(c).toLowerCase()).sort(),
      predicate: r.predicate ? String(r.predicate).toLowerCase().replace(/[()]/g, "").trim() : null,
    });
    byTable.set(r.table_name, list);
  }
  return byTable;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const files = ROOTS.flatMap((r) => {
    try { return walk(r); } catch { return []; }
  });

  const sites: UpsertSite[] = [];
  for (const f of files) sites.push(...upsertSitesIn(readFileSync(f, "utf8"), f));

  const unique = await liveUniqueIndexes();
  const tables = new Set(
    (await query<{ relname: string }>(
      /* ORDINARY TABLES ONLY. A view has no indexes of its own, so including
         them reported every upsert through a view as broken. src/lib/people.ts
         writes to apex_employees, which is a view: that was a false positive,
         not a defect. Views are counted as unchecked below. */
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
    )).rows.map((r) => r.relname),
  );

  const broken: UpsertSite[] = [];
  let skippedUnknownTable = 0;

  for (const s of sites) {
    /* A table this database does not have is not a failure of this check: the
       code may target another tenant's schema, or a view. Counted, not judged. */
    if (!tables.has(s.table)) { skippedUnknownTable++; continue; }
    const want = [...s.columns].sort();
    const has = (unique.get(s.table) ?? []).some((ix) => {
      if (ix.columns.length !== want.length) return false;
      if (!ix.columns.every((c, i) => c === want[i])) return false;
      /* A full index covers any statement. A partial one covers only a
         statement that repeats its predicate. */
      if (!ix.predicate) return true;
      return s.where !== null && ix.predicate.includes(s.where);
    });
    if (!has) broken.push(s);
  }

  if (asJson) {
    console.log(JSON.stringify({ checked: sites.length, broken, skippedUnknownTable }, null, 2));
  } else {
    console.log(`[upsert] ${sites.length} upsert targets read from source`);
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
